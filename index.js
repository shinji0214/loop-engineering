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

// CHECKS=0 で無効化。既定は ON（STEP 4 フェーズ1）。
// 毎ラウンド、生成物を子プロセスで構文チェック＋import 読み込みし、
// 失敗したら Reviewer を呼ばず即 REJECT（決定的ゲート）。
const CHECKS = !/^(0|false|no|off)$/i.test(process.env.CHECKS ?? "");
const CHECK_TIMEOUT_MS = numFromEnv("CHECK_TIMEOUT_MS", 15_000);

// TESTS=1 で有効化（STEP 4 フェーズ2-3、実験中のため既定 OFF）。
// コード生成前に Test Writer → Test Reviewer で受け入れテストを確定・凍結し、
// 実装ループの毎ラウンド `node --test` を実行。失敗したら Code Reviewer を呼ばず即 REJECT。
const TESTS = /^(1|true|yes|on)$/i.test(process.env.TESTS || "");
const TEST_MAX_ROUNDS = numFromEnv("TEST_MAX_ROUNDS", 2); // テスト確定フェーズの上限
const TEST_TIMEOUT_MS = numFromEnv("TEST_TIMEOUT_MS", 30_000);
// テスト失敗時の挙動: reject=即REJECT（既定）/ review=Code Reviewer に結果を渡して判断させる
const TEST_FAIL_MODE = (process.env.TEST_FAIL_MODE || "reject").toLowerCase();
const TEST_WRITER_MODEL = process.env.TEST_WRITER_MODEL || "claude-sonnet-5";
const TEST_REVIEWER_MODEL = process.env.TEST_REVIEWER_MODEL || "claude-sonnet-5";

// FROM_DIR=<path> で既存のファイルツリーを読み込み、currentFiles の初期値にする
// （＝ゼロから作らせるのではなく既存コードの改修・自己編集実験に使う）。
const FROM_DIR = process.env.FROM_DIR || "";
// FROM_DIR がプロジェクトルート等を指しても安全なよう、走査から除外する名前
const FROM_DIR_EXCLUDE = new Set(["node_modules", ".git", "output", "runs", "logs", ".loop-tmp"]);

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
- 「現在のプロジェクト」としてファイルが提示されている場合（既存コードの改修）は、
  **変更するファイルだけ**を出力する。触らないファイルは出さない。
  出さなかったファイルは既存のまま保持される。
- 何も提示されていない新規タスクの場合は、必要なファイルをすべて出力する。
  2回目以降（修正時）は、同様に変更するファイルだけを出力する。
- ファイルを削除したい場合は、言語指定を delete としたブロックにパスを1行ずつ書く:
  \`\`\`delete
  src/old.js
  \`\`\`
- パスに .. や絶対パスは使わない。
- test/ 配下に受け入れテストが与えられている場合、それを全て通すこと。
  **テストファイル（test/ 配下）は出力・変更しない**（凍結済み）。
  テストがタスクと矛盾していると思ったら、コードは出さずその旨だけを述べる。`;

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
- 要件のうち未達の項目があれば明示する。
- （テスト結果が渡された場合）全テストは既に通過している前提。
  「テストは通るがタスク要件を満たしていない」「テストの穴を突いた実装になっている」
  を重点的に見る。テスト自体の不備は改善提案に回す（テストは凍結済みのため）。`;

const TEST_WRITER_SYSTEM = `あなたはテスト作成担当のエンジニアAIです。
タスク（要件）と、その中の入出力例（アンカー）を受け取り、受け入れテストを作ります。

出力は次を **この順で**、すべてコードブロックとして:

1. \`\`\`test/REQUIREMENTS.md
   タスクから抽出した「検証可能な要件」を番号付きで列挙する（1行1要件）。
   タスクに書かれていない要件を作らない。曖昧な表現は具体化して書く。
   テストが import するエントリのパスも1行書く（例: 「エントリ: ../src/index.js」）。
   \`\`\`

2. \`\`\`test/acceptance.test.js
   Node.js 標準の node:test / node:assert だけで書く（外部依存禁止）。
   - REQUIREMENTS.md の各番号に最低1つ、対応する test(...) を書く（test名に「要件N:」を付ける）
   - タスク中の入出力例（アンカー）は**逐語で**テストケースにする
   - 実装は相対 import で読む（例: import x from '../src/index.js'）
   - 仕様に書かれていない実装の詳細を assert しない（公開挙動だけを検証）
   - モックは使わない。標準ライブラリで完結するタスク前提で、実物を呼ぶ
   \`\`\`

テストが書けないタスク（数値化できない/主観的）の場合は、
\`\`\`test/REQUIREMENTS.md
テスト不可: <理由>
\`\`\`
だけを出力する。

修正指示を受けたら、指摘に沿って**変更するファイルだけ**再出力する。`;

const TEST_REVIEWER_SYSTEM = `あなたはテストレビュアーAIです。Test Writer の出力を、コード実装前にチェックします。

入力: 「タスク（要件）」「アンカー（入出力例）」「Test Writer の出力（REQUIREMENTS.md とテスト）」。

## REJECT にできるのは次のいずれか

- 要件列挙がタスクに対して不忠実（勝手に足した / 明記の要件が抜けている / 誤読）
- 要件のうちテストが1つも無いものがある（カバレッジ不足）
- アンカー（入出力例）がテストに逐語で入っていない、または矛盾している
- 仕様に無い実装の詳細を assert している（実装を過剰に縛るテスト）
- モックや外部依存を使っている（標準ライブラリで完結するはずのタスクで）
- テスト自体が構文的に壊れている / import 先が明らかに解決しない

## REJECT にしない（改善提案に回す）

- テストをもっと増やせる、エッジケースを足せる（最低カバレッジを満たしていれば可）
- 命名・構成・スタイル

## 出力フォーマット

- 合格: 先頭行「APPROVE」。任意で「改善提案（対応任意）:」
- 不合格: 先頭行「REJECT」。根拠項目のみ箇条書き（該当ファイル・要件番号・理由）
- 判定は保留しない。`;

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
  try {
    for await (const m of iter) {
      if (m.type === "result") result = m;
    }
  } catch (e) {
    const msg = String(e?.message || e).split("\n")[0];
    if (/authenticate|oauth|session expired|not logged in|login/i.test(msg)) {
      throw new Error(
        "Agent SDK 認証エラー: `claude` のログインが切れています。" +
          "ターミナルで `claude` を一度起動して再ログインしてください（または LOOP_PROVIDER=api）。"
      );
    }
    throw new Error(`Agent SDK 実行エラー: ${msg.slice(0, 300)}`);
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

/**
 * dir 以下を再帰的に読み込み、相対パス -> 内容 の Map を返す（既存コード入力用）。
 * FROM_DIR_EXCLUDE に載っている名前・ドットファイル/ディレクトリはスキップする。
 * バイナリ疑いのファイル（NUL バイトを含む）はスキップする。
 * @param {string} dir
 * @returns {Map<string,string>}
 */
function readFileTree(dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  const root = path.resolve(dir);
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || FROM_DIR_EXCLUDE.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(root, full).replace(/\\/g, "/");
      const buf = fs.readFileSync(full);
      if (buf.includes(0)) continue; // バイナリらしきものは無視
      out.set(rel, buf.toString("utf-8"));
    }
  })(root);
  return out;
}

/** Map<path,content> を {path,content}[] に。 */
function filesFromMap(fileMap) {
  return [...fileMap.entries()].map(([p, content]) => ({ path: p, content }));
}

// --- STEP 4 フェーズ1: 決定的チェック（構文＋読み込み） ---------------------

// チェック用ディレクトリに配置して子プロセスで実行するドライバ。
// 各ファイルを: .json は JSON.parse、.js/.mjs/.cjs は動的 import で読み込み確認。
// import はモジュール本体を実行するので、CLI エントリ等が process.exit を
// 呼んでもドライバが死なないよう exit を無効化する。
// 「読み込みエラー」（構文・モジュール解決・ESM/CJS 不整合）だけを問題として報告し、
// アプリ的な実行時例外は フェーズ1 では無視する（テスト実行は フェーズ3）。
const CHECK_DRIVER = `
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const absRoot = path.resolve(root);
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "_loopcheck.mjs" || e.name.startsWith(".")) continue;
    const p = path.join(d, e.name);
    e.isDirectory() ? walk(p) : files.push(p);
  }
})(root);

const rel = (p) => path.relative(root, p).replace(/\\\\/g, "/");
const scrub = (s) => String(s).split("\\n")[0].split(absRoot).join("").split(absRoot.replace(/\\\\/g, "/")).join("").replace(/\\\\/g, "/").replace(/^[\\/]+/, "");
const problems = [];
const add = (m) => { if (!problems.includes(m)) problems.push(m); };

const LOAD_ERR = /Cannot use import statement|require is not defined|exports is not defined|module is not defined|__dirname is not defined|__filename is not defined|Unexpected (token|identifier|end of)|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|ERR_UNSUPPORTED_DIR_IMPORT|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_UNSUPPORTED_ESM_URL_SCHEME/;

process.exit = () => {}; // import 時に走る CLI エントリの exit を無効化

for (const f of files) {
  const ext = path.extname(f);
  const r = rel(f);
  if (ext === ".json") {
    try { JSON.parse(fs.readFileSync(f, "utf8")); }
    catch (e) { add(r + ": 不正なJSON — " + e.message); }
    continue;
  }
  if (![".js", ".mjs", ".cjs"].includes(ext)) continue;
  try {
    await import(pathToFileURL(f).href + "?t=" + Date.now());
  } catch (e) {
    const tag = (e && (e.name + " " + (e.code || "") + " " + e.message)) || String(e);
    if (e instanceof SyntaxError || LOAD_ERR.test(tag)) {
      add(r + ": 読み込み失敗 — " + scrub(e.message || tag));
    }
  }
}

console.log("__LOOPCHECK__" + JSON.stringify(problems));
`;

/**
 * 累積ファイルを一時ディレクトリに書き出し、子プロセスで構文＋読み込みチェック。
 * @returns {Promise<{ok: boolean, problems: string[]}>}
 */
export async function runChecks(sessionId, roundNum, fileMap) {
  const base = path.join(TMP_DIR, `checks-${sessionId}`);
  const dir = path.join(base, `round-${roundNum}`);
  fs.rmSync(dir, { recursive: true, force: true });
  writeFileTree(dir, filesFromMap(fileMap));
  fs.writeFileSync(path.join(dir, "_loopcheck.mjs"), CHECK_DRIVER, "utf-8");

  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["_loopcheck.mjs", "."], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CHECK_TIMEOUT_MS,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ err: `spawn error: ${e.message}` }));
    child.on("close", (codeExit, signal) => resolve({ out, err, codeExit, signal }));
  });

  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* noop */
  }

  if (res.signal) {
    return {
      ok: false,
      problems: [
        `チェックが ${Math.round(CHECK_TIMEOUT_MS / 1000)} 秒でタイムアウト（無限ループ / 未解決の top-level await の可能性）`,
      ],
    };
  }
  const marker = (res.out || "").split("\n").find((l) => l.startsWith("__LOOPCHECK__"));
  if (marker) {
    try {
      const problems = JSON.parse(marker.slice("__LOOPCHECK__".length));
      return { ok: problems.length === 0, problems };
    } catch {
      /* fall through */
    }
  }
  // マーカーが無い＝ドライバ自体が異常終了
  return {
    ok: false,
    problems: [`チェック実行に失敗: ${(res.err || res.out || "unknown").slice(0, 400)}`],
  };
}

// --- STEP 4 フェーズ2-3: 受け入れテスト（Test Writer / Test Reviewer / node --test） ---

/** タスク文からアンカー（入出力例らしき行）を抜き出して整形。 */
function extractAnchors(task) {
  const lines = task
    .split(/\n|。/)
    .map((s) => s.trim())
    .filter((s) => /例|=>|->|→|とき|なら|返す|出力/.test(s) && s.length > 3);
  return lines.length ? lines.map((l) => `- ${l}`).join("\n") : "(タスク本文から自動抽出できず。本文全体をアンカー候補とする)";
}

/**
 * コード生成前に受け入れテストを確定・凍結する（フェーズ2）。
 * @returns {Promise<{testFiles: Map<string,string>, requirements: string, status: "approved"|"unreviewed"|"untestable"}>}
 */
async function establishTests(task, meter) {
  const anchors = extractAnchors(task);
  const twHistory = [
    {
      role: "user",
      content: `# タスク（要件）\n${task}\n\n# アンカー（入出力例の候補）\n${anchors}`,
    },
  ];
  const testFiles = new Map();
  let requirements = "";

  for (let r = 1; r <= TEST_MAX_ROUNDS; r++) {
    console.log(`\n--- テスト確定 ${r}/${TEST_MAX_ROUNDS} ---`);
    const out = await callAgent(TEST_WRITER_SYSTEM, twHistory, TEST_WRITER_MODEL, meter);
    twHistory.push({ role: "assistant", content: out });
    mergeFiles(testFiles, out);

    const reqFile = testFiles.get("test/REQUIREMENTS.md") || "";
    requirements = reqFile;
    if (/^テスト不可[:：]/m.test(reqFile)) {
      console.log(`[TestWriter] ${reqFile.split("\n")[0]}`);
      return { testFiles: new Map(), requirements: reqFile, status: "untestable" };
    }
    const testCount = [...testFiles.keys()].filter((p) => /\.test\.[cm]?js$/.test(p)).length;
    console.log(`[TestWriter] ${testCount}個のテストファイル / 要件 ${reqFile.split("\n").filter((l) => /^\s*\d/.test(l)).length} 件`);

    const review = await callAgent(
      TEST_REVIEWER_SYSTEM,
      [
        {
          role: "user",
          content:
            `# タスク（要件）\n${task}\n\n# アンカー\n${anchors}\n\n` +
            `# Test Writer の出力\n${renderFiles(testFiles)}`,
        },
      ],
      TEST_REVIEWER_MODEL,
      meter
    );
    const ok = review.trim().startsWith("APPROVE");
    console.log(`[TestReviewer]\n${review}\n`);
    if (ok) return { testFiles, requirements, status: "approved" };

    twHistory.push({
      role: "user",
      content: `テストレビュー結果:\n${review}\n\n現在のテスト:\n${renderFiles(testFiles)}\n\nREJECT の根拠を直し、変更するファイルだけ再出力してください。`,
    });
  }
  console.warn(`[Warn] テストが ${TEST_MAX_ROUNDS} ラウンドで APPROVE されず。暫定テストで続行します`);
  return { testFiles, requirements, status: "unreviewed" };
}

/**
 * コード + 凍結テストを一時ディレクトリに展開し `node --test` を実行。
 * @returns {Promise<{ok: boolean, summary: string, output: string}>}
 */
async function runTests(sessionId, roundNum, codeMap, testMap) {
  const base = path.join(TMP_DIR, `tests-${sessionId}`);
  const dir = path.join(base, `round-${roundNum}`);
  fs.rmSync(dir, { recursive: true, force: true });
  writeFileTree(dir, [...filesFromMap(codeMap), ...filesFromMap(testMap)]);

  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "test/"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TEST_TIMEOUT_MS,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ err: `spawn error: ${e.message}`, codeExit: -1 }));
    child.on("close", (codeExit, signal) => resolve({ out, err, codeExit, signal }));
  });
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* noop */
  }

  const raw = `${res.out || ""}\n${res.err || ""}`.trim();
  if (res.signal) {
    return { ok: false, summary: `テストが ${Math.round(TEST_TIMEOUT_MS / 1000)} 秒でタイムアウト`, output: raw.slice(0, 2000) };
  }
  const pass = Number((raw.match(/^# pass (\d+)/m) || [])[1] || 0);
  const fail = Number((raw.match(/^# fail (\d+)/m) || [])[1] || 0);
  const ok = res.codeExit === 0 && fail === 0 && pass > 0;
  const summary = pass + fail > 0 ? `pass ${pass} / fail ${fail}` : `テスト実行エラー（exit ${res.codeExit}）`;
  // 失敗時は詳細（not ok の行と assert 出力）を優先的に残す
  const detail = ok
    ? ""
    : raw
        .split("\n")
        .filter((l) => /^not ok|^\s*(expected|actual|message|error):|AssertionError|Error:|要件\d/.test(l))
        .slice(0, 40)
        .join("\n");
  return { ok, summary, output: (detail || raw).slice(0, 2500) };
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
  if (d.tests && d.tests.status !== "off") {
    L.push(`- 受け入れテスト: ${d.tests.status}（${d.tests.files.join(", ") || "なし"}）`);
  }
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
  const meter = new TokenMeter({
    budget: TOKEN_BUDGET,
    ratePerMinute: TOKENS_PER_MINUTE,
  });
  let code = ""; // 直近ラウンドの Developer 生出力（ログ・フォールバック表示用）
  const currentFiles = new Map(); // 累積プロジェクト状態: 相対パス -> 内容
  let lastReview = null; // 前ラウンドの Reviewer 出力（回帰ガード用）
  let lastRejectWasAuto = false; // 前ラウンドが決定的ゲート（チェック/テスト）による自動REJECTか
  /** @type {{round:number, verdict:string, changed:string[], deleted:string[], review:string}[]} */
  const rounds = []; // SUMMARY.md 用の遷移記録
  const runsSessionDir = path.join(RUNS_DIR, sessionId);

  // FROM_DIR があれば既存ファイルを currentFiles の初期値にする（既存コードの改修・自己編集用）
  if (FROM_DIR) {
    for (const [p, c] of readFileTree(FROM_DIR)) currentFiles.set(p, c);
    console.log(`[From] ${FROM_DIR} から ${currentFiles.size} 個のファイルを読み込みました`);
  }

  console.log(
    `[Config] provider=${PROVIDER} models=${modelAlias(DEVELOPER_MODEL)}/${modelAlias(REVIEWER_MODEL)} ` +
      `max_rounds=${maxRounds} token_budget=${TOKEN_BUDGET || "無制限"} ` +
      `rate=${TOKENS_PER_MINUTE || "無制限"}/分 checks=${CHECKS ? "on" : "off"} tests=${TESTS ? "on" : "off"}` +
      (FROM_DIR ? ` from=${FROM_DIR}` : "") +
      (PROVIDER === "api" ? ` max_output_tokens=${MAX_OUTPUT_TOKENS}` : "") +
      (PROVIDER === "sdk" && MAX_BUDGET_USD ? ` max_budget_usd=${MAX_BUDGET_USD}` : "")
  );

  // --- フェーズ2: コード生成前に受け入れテストを確定・凍結する ---
  let frozenTests = new Map();
  let testStatus = "off";
  if (TESTS) {
    console.log(`\n=== テスト確定フェーズ ===`);
    const est = await establishTests(task, meter);
    frozenTests = est.testFiles;
    testStatus = est.status;
    if (frozenTests.size) {
      try {
        writeFileTree(path.join(runsSessionDir, "tests"), filesFromMap(frozenTests));
        console.log(`[Tests] 凍結: ${[...frozenTests.keys()].join(", ")}`);
      } catch (e) {
        console.warn(`[Warn] テスト凍結の書き出しに失敗: ${e.message}`);
      }
    } else {
      console.log(`[Tests] テスト無しで続行（status=${testStatus}）`);
    }
    saveLog(sessionId, {
      event: "tests_established",
      status: testStatus,
      files: [...frozenTests.keys()],
      requirements: est.requirements,
      usage: meter.summary(),
    });
  }

  const devHistory = [
    {
      role: "user",
      content:
        task +
        (currentFiles.size
          ? `\n\n# 現在のプロジェクト（既存コード。変更するファイルだけ出力すること）\n${renderFiles(currentFiles)}`
          : "") +
        (frozenTests.size
          ? `\n\n# 与えられた受け入れテスト（test/ 配下・変更禁止・全て通すこと）\n${renderFiles(frozenTests)}`
          : ""),
    },
  ];

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
            tests: { status: testStatus, files: [...frozenTests.keys()] },
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
      tests: { status: testStatus, files: [...frozenTests.keys()] },
      usage: meter.summary(),
    });
    return {
      code,
      files,
      outputDir,
      runsDir,
      status,
      tests: { status: testStatus, files: [...frozenTests.keys()] },
      usage: meter.summary(),
    };
  };

  for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
    console.log(`\n=== Round ${roundNum}/${maxRounds} ===`);

    // ラウンド開始前に予算を確認（前ラウンドで使い切っていたら即停止）
    if (reportBudget(meter)) return finish("budget_exceeded");

    code = await callAgent(DEVELOPER_SYSTEM, devHistory, DEVELOPER_MODEL, meter);
    devHistory.push({ role: "assistant", content: code });

    // 今回の出力を累積状態にマージ（変更ファイルのみ / 削除指示を反映）
    const { changed, deleted } = mergeFiles(currentFiles, code);

    // テストは凍結済み。Developer が test/ を書き換えようとしても無視する。
    if (frozenTests.size) {
      for (const p of [...currentFiles.keys()]) {
        if (p.startsWith("test/") || frozenTests.has(p)) {
          currentFiles.delete(p);
          const i = changed.indexOf(p);
          if (i >= 0) changed.splice(i, 1);
          console.warn(`[Warn] テストは凍結済みです。無視: ${p}`);
        }
      }
    }

    // このラウンド終了時点のスナップショットを runs/<id>/round-N/ に保存
    if (SNAPSHOTS && currentFiles.size) {
      try {
        writeFileTree(path.join(runsSessionDir, `round-${roundNum}`), filesFromMap(currentFiles));
      } catch (e) {
        console.warn(`[Warn] スナップショット保存に失敗: ${e.message}`);
      }
    }

    // 回帰ガード: 前回レビューで名前が出ていないファイルが変更されたら警告。
    // 前回が決定的ゲートの自動REJECT（チェック/テスト失敗）なら「直せ」の意なのでスキップ。
    if (roundNum > 1 && lastReview && !lastRejectWasAuto) {
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

    /** REJECT時、次ラウンドの Developer 入力を積む。 */
    const pushRejectFeedback = (reviewText, opts = {}) => {
      devHistory.push({
        role: "user",
        content:
          `${opts.label || "レビュー結果"}:\n${reviewText}\n\n` +
          `現在のプロジェクト全ファイル:\n${renderFiles(currentFiles)}\n\n` +
          (opts.instruction ||
            `REJECT の根拠になった項目を最優先で修正し、**変更するファイルだけ**出力してください。` +
              `「改善提案（対応任意）」は、コストが小さく明らかに有益なものだけ取り込めば十分です。`),
      });
    };

    /** LLM を呼ばずに REJECT を確定させる（決定的ゲート用）。 */
    const autoReject = (reviewText, logExtra, feedbackOpts) => {
      lastReview = reviewText;
      lastRejectWasAuto = true;
      rounds.push({ round: roundNum, verdict: "REJECT", changed, deleted, review: reviewText });
      saveLog(sessionId, {
        round: roundNum,
        developer_output: code,
        changed_files: changed,
        deleted_files: deleted,
        reviewer_output: reviewText,
        verdict: "REJECT",
        usage: meter.summary(),
        ...logExtra,
      });
      console.log(
        `[Usage] 累計 ${meter.total} トークン（入力 ${meter.totalInput} / 出力 ${meter.totalOutput}）`
      );
      pushRejectFeedback(reviewText, feedbackOpts);
    };

    // --- 決定的チェック（フェーズ1）: 失敗なら Reviewer を呼ばず即 REJECT ---
    if (CHECKS && currentFiles.size) {
      const { ok, problems } = await runChecks(sessionId, roundNum, currentFiles);
      if (!ok) {
        console.log(`[Checks] NG\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
        autoReject(
          "REJECT\n決定的チェック（構文・読み込み）で失敗:\n" + problems.map((p) => `- ${p}`).join("\n"),
          { checks: problems },
          {
            label: "自動チェック結果",
            instruction:
              "まず全ファイルがエラーなく読み込める状態にしてください（構文エラー・" +
              "モジュール解決エラー・ESM/CommonJS の不整合など）。**変更するファイルだけ**出力してください。",
          }
        );
        if (reportBudget(meter)) return finish("budget_exceeded");
        continue; // Reviewer を呼ばず次ラウンドへ
      }
      console.log(`[Checks] OK`);
    }

    // --- 受け入れテスト（フェーズ3）: node --test ---
    let testEvidence = "";
    if (frozenTests.size && currentFiles.size) {
      const t = await runTests(sessionId, roundNum, currentFiles, frozenTests);
      console.log(`[Tests] ${t.summary}`);
      if (!t.ok && TEST_FAIL_MODE === "reject") {
        autoReject(
          `REJECT\n受け入れテストが失敗（${t.summary}）:\n\n${t.output}`,
          { tests: t.summary, test_output: t.output },
          {
            label: "テスト結果",
            instruction:
              "失敗したテストを通してください。テストファイル（test/ 配下）は変更しません。" +
              "**変更するファイルだけ**出力してください。",
          }
        );
        if (reportBudget(meter)) return finish("budget_exceeded");
        continue; // Code Reviewer を呼ばず次ラウンドへ
      }
      testEvidence = t.ok
        ? `\n\n# 受け入れテスト結果\n全通過（${t.summary}）`
        : `\n\n# 受け入れテスト結果（失敗あり）\n${t.summary}\n\`\`\`\n${t.output}\n\`\`\``;
    }

    // Reviewer には累積したプロジェクト全体を見せる（差分だけ見せない）
    const projectView = currentFiles.size ? renderFiles(currentFiles) : code;
    const review = await callAgent(
      REVIEWER_SYSTEM,
      [
        {
          role: "user",
          content: `# 元のタスク（要件）\n${task}\n\n# 現在のプロジェクト全体\n${projectView}${testEvidence}`,
        },
      ],
      REVIEWER_MODEL,
      meter
    );
    console.log(`[Reviewer]\n${review}\n`);
    lastReview = review;
    lastRejectWasAuto = false;

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

    pushRejectFeedback(review);
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

  const { code, files, outputDir, runsDir, status, tests, usage } = await runLoop(task);

  console.log("\n" + "=".repeat(50));
  console.log(`最終ステータス: ${status}`);
  console.log(`消費トークン: ${usage.total}（入力 ${usage.input} / 出力 ${usage.output}）`);
  if (tests && tests.status !== "off") {
    console.log(`受け入れテスト: ${tests.status}（${tests.files.join(", ") || "なし"}）`);
  }
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
  main().catch((e) => {
    console.error(`\n[Error] ${e?.message || e}`);
    process.exit(1);
  });
}
