/**
 * Multi-Agent Dev/Review System — STEP 2 + トークン安全弁
 *
 * Developer Agent と Reviewer Agent が交互にやり取りし、
 * Reviewer が APPROVE を出すか、最大ラウンド数に達するまで
 * コードの生成・修正を繰り返す最小構成。
 *
 * さらに STEP 5 の先取りとして、トークンの
 *   - 1回あたり最大出力サイズ (MAX_OUTPUT_TOKENS)
 *   - 消費スピード上限 (TOKENS_PER_MINUTE)
 *   - 合計消費量の上限 (TOKEN_BUDGET) 超過時の自動停止
 * を実装している。
 *
 * Developer は複数ファイルを出力でき（```相対パス で始まるコードブロック）、
 * 承認された（または最後の）成果物は output/<セッションID>/ 以下に書き出す。
 * Reviewer には元のタスク文も渡すので、要件の充足度を判定できる。
 *
 * ■ 実行方法（既定は sdk。LOOP_PROVIDER で切り替え）
 *
 *   1. Claude Agent SDK 経由（既定 / LOOP_PROVIDER=sdk）
 *      → `claude` CLI と同じサブスク（Pro/Max）ログインを使う。API キー不要。
 *        claude              # 一度ログインしておく
 *        node index.js "タスクの説明"
 *
 *   2. `claude` CLI をサブプロセスで叩く（LOOP_PROVIDER=cli）
 *      → sdk と同じ認証。SDK が動かない環境向けのフォールバック。
 *        CLAUDE_CLI_PATH で実行ファイルを指定できる。
 *
 *   3. Anthropic API を直接叩く（LOOP_PROVIDER=api）
 *        export ANTHROPIC_API_KEY=sk-ant-xxxx
 *        LOOP_PROVIDER=api node index.js "タスクの説明"
 *
 * 設定は環境変数で上書きできる:
 *   TOKEN_BUDGET=200000 TOKENS_PER_MINUTE=60000 MAX_BUDGET_USD=0.5 node index.js "..."
 *
 * ※ Agent SDK のサブスク認証を「自作プロダクトの機能として他人に提供」するのは
 *   Anthropic の規約上NG。手元の個人利用に限る（配布するなら api モード）。
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEVELOPER_MODEL = process.env.DEVELOPER_MODEL || "claude-sonnet-5";
// Pro プランでは opus の利用枠が小さいため、Reviewer も既定は sonnet にしている。
// opus の枠に余裕があるなら REVIEWER_MODEL=claude-opus-5 に戻すと自己採点の甘さを避けやすい。
const REVIEWER_MODEL = process.env.REVIEWER_MODEL || "claude-sonnet-5";
const MAX_ROUNDS = numFromEnv("MAX_ROUNDS", 5);

// sdk（Claude Agent SDK）/ cli（`claude` サブプロセス）/ api（Anthropic API 直叩き）。
// 既定は sdk（Claude Pro/Max のサブスクログインをそのまま使う）。
const PROVIDER = (process.env.LOOP_PROVIDER || "sdk").toLowerCase();

// --- トークン安全弁の設定 ---------------------------------------------------
// 1回の呼び出しで生成させる最大トークン数（出力の頭打ち）。
// ※ api モードでのみ強制される。sdk / cli は `claude` 側に上限指定の口がないため参考値。
const MAX_OUTPUT_TOKENS = numFromEnv("MAX_OUTPUT_TOKENS", 8000);
// ループ全体で消費できる合計トークン数（input + output）。到達したら自動停止。
// ※ sdk / cli モードは `claude` 本体のシステムプロンプト分（初回だけ数万トークン）が
//    加算されるので、api モードより大きめに設定するとよい。
const TOKEN_BUDGET = numFromEnv("TOKEN_BUDGET", 100_000);
// 消費スピードの上限（トークン/分）。直近60秒の消費がこれを超えると、
// 超過分が枠から外れるまで次の呼び出しを待機させる。0 で無効
const TOKENS_PER_MINUTE = numFromEnv("TOKENS_PER_MINUTE", 40_000);
// 1回の生成のコスト上限(USD)。sdk モードのみ有効（SDK の maxBudgetUsd に渡す）。0 で無効。
const MAX_BUDGET_USD = numFromEnv("MAX_BUDGET_USD", 0);
// -------------------------------------------------------------------------

// VERBOSE=1 で Developer の生成コードを毎ラウンド全文表示。
// 既定は OFF（ファイル一覧＋行数だけ表示。全文は logs/ と output/ にある）。
const VERBOSE = /^(1|true|yes|on)$/i.test(process.env.VERBOSE || "");

// SNAPSHOTS=0 で無効化。既定は ON（各ラウンド終了時点のファイル群を
// runs/<セッションID>/round-N/ に保存し、finish で SUMMARY.md を生成）。
const SNAPSHOTS = !/^(0|false|no|off)$/i.test(process.env.SNAPSHOTS ?? "");

const DEVELOPER_SYSTEM = `あなたは実装担当のエンジニアAIです。
与えられた要件を満たすコードを、動作する形で出力してください。
レビュー指摘を受け取った場合は、指摘内容を反映して修正版を出力してください。

出力ルール:
- 出力はコードブロックのみ。前置き・あとがき・説明文は書かない。
- 各コードブロックの言語指定の位置に「プロジェクトルートからの相対パス」を書く。
  例:
  \`\`\`src/index.js
  ...ファイルの内容...
  \`\`\`
  \`\`\`package.json
  ...ファイルの内容...
  \`\`\`
- 1ファイルで足りる場合もパスを必ず付ける（例: \`\`\`solution.js）。
- 初回は必要なファイルをすべて出力する。
- 2回目以降（修正時）は、**変更するファイルだけ**を出力する。触らないファイルは出さない。
  出さなかったファイルは前回のまま保持される。
- ファイルを削除したい場合は、言語指定を delete としたブロックにパスを1行ずつ書く:
  \`\`\`delete
  src/old.js
  \`\`\`
- パスに .. や絶対パスは使わない。`;

const REVIEWER_SYSTEM = `あなたはコードレビュアーAIです。重大な欠陥には厳格に、
些細な改善要望には寛容に判定します。

入力: 「元のタスク（要件）」と「Developerの出力（複数ファイルの場合あり）」。

## 判定ルール（重大度ゲート）

REJECT にできるのは、次のいずれかに該当する場合だけです:
- 要件違反: タスクに明記された条件・エッジケース・成果物が満たされていない
- 明確なバグ: ロジックの誤り、クラッシュ、データ破壊、明らかな誤動作
- セキュリティ上の問題

次は REJECT の理由にしてはいけません（APPROVE した上で「改善提案」に回す）:
- タスクに書かれていない堅牢性の強化（追加のエラーハンドリング等）
- スタイル・命名・可読性・コメントやドキュメントの細かい不一致
- Developer が自主的に足した仕様外の機能や、その説明不足
- タスクに無い基準を持ち出しての「不足」の主張

コメント/ドキュメントと実装の不一致は、それがタスク要件に関わるときのみ REJECT。
それ以外は改善提案に回す。判定は必ず APPROVE か REJECT のどちらかにする（保留しない）。

## 出力フォーマット

- 合格の場合: 先頭行に「APPROVE」。必要なら続けて
    改善提案（対応任意）:
    - ...
- 不合格の場合: 先頭行に「REJECT」。続けて、REJECT の根拠になった項目だけを
  箇条書きで、該当ファイル・箇所・理由を添えて書く。任意で最後に
  「改善提案（対応任意）:」を分けて書いてよい。
- 憶測で判定しない。指摘には必ず根拠（該当箇所）を添える。
- 要件のうち未達の項目があれば明示する。`;

const LOG_DIR = path.join(__dirname, "logs");
const TMP_DIR = path.join(__dirname, ".loop-tmp");
const OUTPUT_DIR = path.join(__dirname, "output"); // 最終成果物（deliverable）
const RUNS_DIR = path.join(__dirname, "runs"); // ラウンドごとのスナップショット＋遷移サマリ

// api モードでのみ使用（cli モードなら未認証でも生成される）
const apiClient = new Anthropic();

function numFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * トークン消費量の計測・レート制限・予算チェックをまとめて担う。
 */
class TokenMeter {
  /** @param {{budget: number, ratePerMinute: number}} opts */
  constructor({ budget, ratePerMinute }) {
    this.budget = budget;
    this.ratePerMinute = ratePerMinute;
    this.totalInput = 0;
    this.totalOutput = 0;
    /** @type {{t: number, tokens: number}[]} 直近の消費イベント（レート制限用） */
    this.events = [];
  }

  get total() {
    return this.totalInput + this.totalOutput;
  }

  /** 直近60秒の消費量がレート上限を超えている間だけ待機する。 */
  async throttle() {
    if (!this.ratePerMinute) return;
    for (;;) {
      const now = Date.now();
      this.events = this.events.filter((e) => now - e.t < 60_000);
      const used = this.events.reduce((s, e) => s + e.tokens, 0);
      if (used < this.ratePerMinute || this.events.length === 0) return;
      const waitMs = 60_000 - (now - this.events[0].t);
      console.log(
        `[RateLimit] 直近60秒で ${used} トークン消費（上限 ${this.ratePerMinute}/分）。` +
          `${Math.ceil(waitMs / 1000)} 秒待機します`
      );
      await sleep(waitMs);
    }
  }

  /** 1回の応答の usage を消費量に加算する。 */
  record(usage) {
    const input = usage?.input_tokens ?? 0;
    const output = usage?.output_tokens ?? 0;
    this.totalInput += input;
    this.totalOutput += output;
    this.events.push({ t: Date.now(), tokens: input + output });
  }

  /** 予算超過なら理由文字列、問題なければ null を返す。 */
  budgetExceededReason() {
    if (this.budget && this.total >= this.budget) {
      return (
        `トークン予算 ${this.budget} に到達（消費 ${this.total} = ` +
        `入力 ${this.totalInput} + 出力 ${this.totalOutput}）`
      );
    }
    return null;
  }

  summary() {
    return { input: this.totalInput, output: this.totalOutput, total: this.total };
  }
}

// --- モデル呼び出し（プロバイダ差を吸収） ----------------------------------

/**
 * @param {string} system
 * @param {{role: "user"|"assistant", content: string}[]} messages
 * @param {string} model
 * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}, truncated: boolean}>}
 */
async function generate(system, messages, model) {
  if (PROVIDER === "cli") return generateViaCli(system, messages, model);
  if (PROVIDER === "api") return generateViaApi(system, messages, model);
  return generateViaSdk(system, messages, model);
}

// コード生成に不要な組み込みツールは外す（勝手にファイル操作・検索させない）
const DISABLED_TOOLS = [
  "Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Glob", "Grep", "WebSearch", "WebFetch", "Task", "TodoWrite",
];

/** DEVELOPER_MODEL / REVIEWER_MODEL のフルID を CLI/SDK のエイリアスに丸める。 */
function modelAlias(model) {
  if (/opus/i.test(model)) return "opus";
  if (/haiku/i.test(model)) return "haiku";
  if (/fable/i.test(model)) return "fable";
  return "sonnet";
}

async function generateViaSdk(system, messages, model) {
  const iter = query({
    prompt: historyToPrompt(messages),
    options: {
      model: modelAlias(model),
      systemPrompt: system, // 文字列を渡すと claude_code 既定プロンプトを完全に置き換える
      allowedTools: [],
      disallowedTools: DISABLED_TOOLS,
      settingSources: [], // ~/.claude や プロジェクトの .claude を読み込まない（決定性のため）
      maxTurns: 2,
      ...(MAX_BUDGET_USD ? { maxBudgetUsd: MAX_BUDGET_USD } : {}),
      stderr: () => {},
    },
  });

  let result;
  for await (const m of iter) {
    if (m.type === "result") result = m;
  }
  if (!result) throw new Error("Agent SDK: result メッセージが得られませんでした");
  if (result.subtype !== "success") {
    const detail = result.errors?.length ? ` / ${result.errors.join("; ")}` : "";
    throw new Error(`Agent SDK エラー: ${result.subtype}${detail}`);
  }

  const u = result.usage ?? {};
  return {
    text: result.result ?? "",
    usage: {
      // cache_read（使い回し分）は除外。新規処理された入力＋出力で計測。
      input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      output_tokens: u.output_tokens ?? 0,
    },
    truncated: result.stop_reason === "max_tokens",
  };
}

async function generateViaApi(system, messages, model) {
  const resp = await apiClient.messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system,
    messages,
  });
  const u = resp.usage ?? {};
  return {
    text: resp.content.find((b) => b.type === "text")?.text ?? "",
    usage: {
      input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      output_tokens: u.output_tokens ?? 0,
    },
    truncated: resp.stop_reason === "max_tokens",
  };
}

/** 会話履歴を 1本のプロンプト文字列へ畳む（sdk / cli は単発呼び出しのため）。 */
function historyToPrompt(messages) {
  return messages
    .map((m) =>
      m.role === "user"
        ? m.content
        : `--- 前回のあなた（Developer）の出力 ---\n${m.content}`
    )
    .join("\n\n");
}

async function generateViaCli(system, messages, model) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const sysFile = path.join(
    TMP_DIR,
    `sys-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  );
  fs.writeFileSync(sysFile, system, "utf-8");

  const args = [
    "-p",
    "--model", modelAlias(model),
    "--system-prompt-file", sysFile,
    "--output-format", "json",
    "--no-session-persistence",
    // コード生成に不要なツールは止めておく（勝手にファイル操作させない）
    "--disallowedTools", "Bash", "Edit", "Write", "Read",
    "WebSearch", "WebFetch", "Task", "Glob", "Grep", "NotebookEdit",
  ];
  const bin = process.env.CLAUDE_CLI_PATH || "claude";

  let raw;
  try {
    raw = await new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        shell: process.platform === "win32", // Windows の claude.cmd 対策
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) =>
        reject(
          new Error(
            `claude CLI を起動できません（${bin}）: ${e.message}\n` +
              `CLAUDE_CLI_PATH で実行ファイルを指定するか、LOOP_PROVIDER=api を使ってください`
          )
        )
      );
      child.on("close", (code) => {
        if (code !== 0) {
          reject(
            new Error(`claude CLI が異常終了 (code ${code}): ${(err || out).slice(0, 500)}`)
          );
          return;
        }
        resolve(out);
      });
      child.stdin.write(historyToPrompt(messages));
      child.stdin.end();
    });
  } finally {
    try {
      fs.unlinkSync(sysFile);
    } catch {
      /* noop */
    }
  }

  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new Error(`claude CLI 応答をJSONとして解釈できません: ${raw.slice(0, 300)}`);
  }
  if (j.is_error || j.subtype !== "success") {
    throw new Error(`claude CLI エラー: ${j.result || j.subtype || "不明"}`);
  }

  const u = j.usage ?? {};
  // cache_read（使い回し分）は実質ゼロコストなので除外し、
  // 新規に処理された入力（＝ input + cache_creation）＋出力で計測する。
  return {
    text: j.result ?? "",
    usage: {
      input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      output_tokens: u.output_tokens ?? 0,
    },
    truncated: j.stop_reason === "max_tokens",
  };
}

// --- ループ本体 -----------------------------------------------------------

/**
 * @param {string} system
 * @param {{role: "user"|"assistant", content: string}[]} messages
 * @param {string} model
 * @param {TokenMeter} meter
 * @returns {Promise<string>}
 */
async function callAgent(system, messages, model, meter) {
  await meter.throttle();
  const { text, usage, truncated } = await generate(system, messages, model);
  meter.record(usage);
  if (truncated) {
    const hint = PROVIDER === "api" ? `（MAX_OUTPUT_TOKENS=${MAX_OUTPUT_TOKENS}）` : "";
    console.warn(
      `[Warn] ${model} の出力が最大トークン数で打ち切られました${hint}。途中で切れている可能性があります`
    );
  }
  return text;
}

function saveLog(sessionId, entry) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${sessionId}.jsonl`);
  fs.appendFileSync(
    logPath,
    JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n",
    "utf-8"
  );
}

/** 言語指定の位置がパスっぽい（/ を含む、または末尾が拡張子）か。 */
function looksLikePath(info) {
  if (!info) return false;
  return /[\\/]/.test(info) || /\.[A-Za-z0-9]{1,8}$/.test(info);
}

/**
 * Developer の出力テキストから ```相対パス ... ``` のブロックを抜き出す。
 * パス付きブロックが1つも無ければ [] を返す（＝ファイル書き出しはしない）。
 * 制約: ファイル内容自体に ``` 行が含まれる場合（Markdown等）はそこで途切れる。
 * @param {string} text
 * @returns {{path: string, content: string}[]}
 */
export function parseFiles(text) {
  const files = [];
  const fence = /^```([^\n`]*)\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
  let m;
  while ((m = fence.exec(text)) !== null) {
    const info = m[1].trim();
    if (!looksLikePath(info)) continue;
    files.push({ path: info.replace(/\\/g, "/"), content: m[2] });
  }
  return files;
}

/**
 * Developer 出力から削除指示（```delete ... ``` ブロック）を抜き出す。
 * @param {string} text
 * @returns {string[]} 削除対象の相対パス
 */
function parseDeletes(text) {
  const out = [];
  const fence = /^```delete[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
  let m;
  while ((m = fence.exec(text)) !== null) {
    for (const line of m[1].split("\n")) {
      const p = line.trim().replace(/\\/g, "/");
      if (p) out.push(p);
    }
  }
  return out;
}

/** 累積ファイル Map を Developer / Reviewer に読ませる1つのテキストへ整形。 */
function renderFiles(fileMap) {
  return [...fileMap.entries()]
    .map(([p, content]) => "```" + p + "\n" + content + "\n```")
    .join("\n\n");
}

/**
 * Developer の今回の出力を累積ファイル Map にマージする。
 * @param {Map<string,string>} fileMap - 破壊的に更新される
 * @param {string} code
 * @returns {{changed: string[], deleted: string[]}}
 */
function mergeFiles(fileMap, code) {
  const changed = [];
  for (const f of parseFiles(code)) {
    if (fileMap.get(f.path) !== f.content) changed.push(f.path);
    fileMap.set(f.path, f.content);
  }
  const deleted = [];
  for (const p of parseDeletes(code)) {
    if (fileMap.delete(p)) deleted.push(p);
  }
  return { changed, deleted };
}

/** base の外に出ないよう相対パスを解決する。ダメなら例外。 */
function safeResolve(base, rel) {
  const resolved = path.resolve(base, rel);
  const rootWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (resolved !== base && !resolved.startsWith(rootWithSep)) {
    throw new Error(`不正なファイルパス: ${rel}`);
  }
  return resolved;
}

/**
 * ファイル群を dir 以下に実書き出しする（パスは dir の外に出られない）。
 * @returns {string|null} 書き出し先ディレクトリ（ファイルが無ければ null）
 */
function writeFileTree(dir, files) {
  if (!files.length) return null;
  for (const f of files) {
    const dest = safeResolve(dir, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.content, "utf-8");
  }
  return dir;
}

/** Map<path,content> を {path,content}[] に。 */
function filesFromMap(fileMap) {
  return [...fileMap.entries()].map(([p, content]) => ({ path: p, content }));
}

/**
 * 遷移サマリ Markdown を組み立てる。
 * @param {{
 *   task: string, sessionId: string, status: string, maxRounds: number,
 *   usage: {input:number,output:number,total:number},
 *   finalPaths: string[],
 *   rounds: {round:number, verdict:string, changed:string[], deleted:string[], review:string}[],
 * }} d
 */
function buildSummary(d) {
  const L = [];
  L.push(`# 実行サマリ — ${d.sessionId}`, "");
  L.push(`- タスク: ${d.task}`);
  L.push(
    `- provider: ${PROVIDER} / models: ${modelAlias(DEVELOPER_MODEL)} (dev) / ${modelAlias(REVIEWER_MODEL)} (review)`
  );
  L.push(`- 最終ステータス: **${d.status}**`);
  L.push(`- ラウンド: ${d.rounds.length} / ${d.maxRounds}`);
  L.push(`- 消費トークン: ${d.usage.total}（入力 ${d.usage.input} / 出力 ${d.usage.output}）`);
  L.push(`- 最終ファイル: ${d.finalPaths.join(", ") || "(なし)"}`);
  L.push("");
  L.push("## 遷移", "");
  L.push("| R | 判定 | 変更 | 削除 | 前ラウンド指摘への対応 |");
  L.push("|---|---|---|---|---|");
  d.rounds.forEach((r, i) => {
    const prev = d.rounds[i - 1];
    let followUp = "—";
    if (prev && prev.verdict === "REJECT") {
      if (r.verdict === "APPROVE") {
        followUp = "✅ 承認";
      } else {
        // 前回レビューで名指しされたファイルを今回変更したか
        const touched = r.changed.filter((p) => prev.review.includes(p));
        followUp = touched.length ? `🔧 ${touched.join(" ")} を再修正` : "🔁 再REJECT";
      }
    }
    L.push(
      `| ${r.round} | ${r.verdict} | ${r.changed.join(" ") || "—"} | ${
        r.deleted.join(" ") || "—"
      } | ${followUp} |`
    );
  });
  L.push("");
  if (d.rounds.length >= 2) {
    L.push(
      "ラウンド間の差分:",
      "```",
      `diff -r runs/${d.sessionId}/round-1 runs/${d.sessionId}/round-2`,
      "```",
      ""
    );
  }
  L.push("## ラウンド詳細");
  for (const r of d.rounds) {
    L.push("", `### Round ${r.round} — ${r.verdict}`, "");
    const chg = r.changed.join(", ") || "—";
    const del = r.deleted.length ? ` / 削除: ${r.deleted.join(", ")}` : "";
    L.push(`変更ファイル: ${chg}${del}`, "", "Reviewer:", "", "```", r.review.trim(), "```");
  }
  return L.join("\n") + "\n";
}

/**
 * @param {string} task
 * @param {number} maxRounds
 * @returns {Promise<{
 *   code: string,
 *   files: {path: string, content: string}[],
 *   outputDir: string|null,
 *   runsDir: string|null,
 *   status: "approved"|"max_rounds_reached"|"budget_exceeded",
 *   usage: {input: number, output: number, total: number}
 * }>}
 */
export async function runLoop(task, maxRounds = MAX_ROUNDS) {
  const sessionId = new Date().toISOString().replace(/[:.]/g, "-");
  const devHistory = [{ role: "user", content: task }];
  const meter = new TokenMeter({
    budget: TOKEN_BUDGET,
    ratePerMinute: TOKENS_PER_MINUTE,
  });
  let code = ""; // 直近ラウンドの Developer 生出力（ログ・フォールバック表示用）
  const currentFiles = new Map(); // 累積プロジェクト状態: 相対パス -> 内容
  let lastReview = null; // 前ラウンドの Reviewer 出力（回帰ガード用）
  /** @type {{round:number, verdict:string, changed:string[], deleted:string[], review:string}[]} */
  const rounds = []; // SUMMARY.md 用の遷移記録
  const runsSessionDir = path.join(RUNS_DIR, sessionId);

  console.log(
    `[Config] provider=${PROVIDER} models=${modelAlias(DEVELOPER_MODEL)}/${modelAlias(REVIEWER_MODEL)} ` +
      `max_rounds=${maxRounds} token_budget=${TOKEN_BUDGET || "無制限"} ` +
      `rate=${TOKENS_PER_MINUTE || "無制限"}/分` +
      (PROVIDER === "api" ? ` max_output_tokens=${MAX_OUTPUT_TOKENS}` : "") +
      (PROVIDER === "sdk" && MAX_BUDGET_USD ? ` max_budget_usd=${MAX_BUDGET_USD}` : "")
  );

  /** 終了時の共通処理: 成果物と遷移サマリを書き出して結果オブジェクトを返す。 */
  const finish = (status) => {
    const files = filesFromMap(currentFiles);
    let outputDir = null;
    try {
      outputDir = writeFileTree(path.join(OUTPUT_DIR, sessionId), files);
    } catch (e) {
      console.warn(`[Warn] 成果物の書き出しに失敗: ${e.message}`);
    }
    if (outputDir) {
      console.log(`[Files] ${files.length}個のファイルを ${outputDir} に書き出しました`);
    }

    // 遷移サマリ（SUMMARY.md）を生成
    let runsDir = null;
    if (SNAPSHOTS && rounds.length) {
      try {
        fs.mkdirSync(runsSessionDir, { recursive: true });
        fs.writeFileSync(
          path.join(runsSessionDir, "SUMMARY.md"),
          buildSummary({
            task,
            sessionId,
            status,
            maxRounds,
            usage: meter.summary(),
            finalPaths: files.map((f) => f.path),
            rounds,
          }),
          "utf-8"
        );
        runsDir = runsSessionDir;
        console.log(`[Runs] 遷移サマリ: ${path.join(runsDir, "SUMMARY.md")}`);
      } catch (e) {
        console.warn(`[Warn] SUMMARY.md の生成に失敗: ${e.message}`);
      }
    }

    saveLog(sessionId, {
      event: "finish",
      status,
      files: files.map((f) => f.path),
      output_dir: outputDir,
      runs_dir: runsDir,
      usage: meter.summary(),
    });
    return { code, files, outputDir, runsDir, status, usage: meter.summary() };
  };

  for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
    console.log(`\n=== Round ${roundNum}/${maxRounds} ===`);

    // ラウンド開始前に予算を確認（前ラウンドで使い切っていたら即停止）
    if (reportBudget(meter)) return finish("budget_exceeded");

    code = await callAgent(DEVELOPER_SYSTEM, devHistory, DEVELOPER_MODEL, meter);
    devHistory.push({ role: "assistant", content: code });

    // 今回の出力を累積状態にマージ（変更ファイルのみ / 削除指示を反映）
    const { changed, deleted } = mergeFiles(currentFiles, code);

    // このラウンド終了時点のスナップショットを runs/<id>/round-N/ に保存
    if (SNAPSHOTS && currentFiles.size) {
      try {
        writeFileTree(path.join(runsSessionDir, `round-${roundNum}`), filesFromMap(currentFiles));
      } catch (e) {
        console.warn(`[Warn] スナップショット保存に失敗: ${e.message}`);
      }
    }

    // 回帰ガード: 前回レビューで名前が出ていないファイルが変更されたら警告
    if (roundNum > 1 && lastReview) {
      const unflagged = changed.filter((p) => !lastReview.includes(p));
      if (unflagged.length) {
        console.warn(`[Warn] レビュー指摘に無いファイルが変更されました: ${unflagged.join(", ")}`);
      }
    }

    if (VERBOSE) {
      console.log(`[Developer]\n${code}\n`);
    } else {
      const delNote = deleted.length ? ` / 削除 ${deleted.join(", ")}` : "";
      console.log(
        `[Developer] 変更 ${changed.length} / 全 ${currentFiles.size} ファイル${delNote}\n` +
          `${summarizeDevOutput(code)}\n`
      );
    }

    if (reportBudget(meter)) return finish("budget_exceeded");

    // Reviewer には累積したプロジェクト全体を見せる（差分だけ見せない）
    const projectView = currentFiles.size ? renderFiles(currentFiles) : code;
    const review = await callAgent(
      REVIEWER_SYSTEM,
      [
        {
          role: "user",
          content: `# 元のタスク（要件）\n${task}\n\n# 現在のプロジェクト全体\n${projectView}`,
        },
      ],
      REVIEWER_MODEL,
      meter
    );
    console.log(`[Reviewer]\n${review}\n`);
    lastReview = review;

    const verdict = review.trim().startsWith("APPROVE") ? "APPROVE" : "REJECT";
    rounds.push({ round: roundNum, verdict, changed, deleted, review });

    saveLog(sessionId, {
      round: roundNum,
      developer_output: code,
      changed_files: changed,
      deleted_files: deleted,
      reviewer_output: review,
      verdict,
      usage: meter.summary(),
    });
    console.log(
      `[Usage] 累計 ${meter.total} トークン（入力 ${meter.totalInput} / 出力 ${meter.totalOutput}）`
    );

    if (verdict === "APPROVE") {
      console.log(`=== 合格（Round ${roundNum}で承認） ===`);
      return finish("approved");
    }

    if (reportBudget(meter)) return finish("budget_exceeded");

    devHistory.push({
      role: "user",
      content:
        `レビュー結果:\n${review}\n\n` +
        `現在のプロジェクト全ファイル:\n${renderFiles(currentFiles)}\n\n` +
        `REJECT の根拠になった項目を最優先で修正し、**変更するファイルだけ**出力してください。` +
        `「改善提案（対応任意）」は、コストが小さく明らかに有益なものだけ取り込めば十分です。`,
    });
  }

  console.log(`=== 最大ラウンド（${maxRounds}）に到達したため停止 ===`);
  return finish("max_rounds_reached");
}

/** Developer 出力の要約行（VERBOSE=OFF 用）。全文は logs/ と output/ にある。 */
function summarizeDevOutput(code) {
  const files = parseFiles(code);
  if (files.length) {
    return files
      .map((f) => `  - ${f.path} (${f.content.split("\n").length} 行)`)
      .join("\n");
  }
  const lines = code.split("\n");
  const head = lines.slice(0, 8).join("\n");
  return lines.length > 8 ? `${head}\n  … 他 ${lines.length - 8} 行` : head;
}

/** 予算超過なら理由をログ出力して true を返す。 */
function reportBudget(meter) {
  const reason = meter.budgetExceededReason();
  if (reason) {
    console.log(`=== トークン上限に達したため自動停止: ${reason} ===`);
    return true;
  }
  return false;
}

async function main() {
  const task = process.argv[2];
  if (!task) {
    console.log('使い方: node index.js "タスクの説明"');
    process.exit(1);
  }

  const { code, files, outputDir, runsDir, status, usage } = await runLoop(task);

  console.log("\n" + "=".repeat(50));
  console.log(`最終ステータス: ${status}`);
  console.log(`消費トークン: ${usage.total}（入力 ${usage.input} / 出力 ${usage.output}）`);
  if (runsDir) console.log(`遷移サマリ: ${path.join(runsDir, "SUMMARY.md")}`);
  if (outputDir) {
    console.log(`成果物: ${outputDir}`);
    for (const f of files) console.log(`  - ${f.path}`);
    if (VERBOSE) {
      console.log("=".repeat(50));
      console.log(code);
    }
  } else {
    // パス付きコードブロックが無く書き出せなかった場合は生出力を出す（VERBOSE 問わず）
    console.log("成果物: パス付きコードブロックが無かったため未書き出し（生出力を表示）");
    console.log("=".repeat(50));
    console.log(code);
  }

  if (status !== "approved") process.exitCode = 1;
}

// このファイルが直接実行された場合のみ main() を走らせる
// (STEP 3でExpressから import して使う際に自動実行されないようにするため)
// Windows でも動くよう pathToFileURL で比較する
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
