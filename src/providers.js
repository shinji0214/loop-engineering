/** モデル呼び出し（sdk / cli / api のプロバイダ差を吸収）。 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  PROVIDER, MAX_OUTPUT_TOKENS, MAX_BUDGET_USD, SDK_MAX_TURNS, TMP_DIR,
} from "./config.js";

// api モードでのみ使用（cli / sdk モードなら未認証でも生成される）
const apiClient = new Anthropic();

// コード生成に不要な組み込みツールは外す（勝手にファイル操作・検索させない）
const DISABLED_TOOLS = [
  "Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
  "Glob", "Grep", "WebSearch", "WebFetch", "Task", "TodoWrite",
];

/** DEVELOPER_MODEL / REVIEWER_MODEL のフルID を CLI/SDK のエイリアスに丸める。 */
export function modelAlias(model) {
  if (/opus/i.test(model)) return "opus";
  if (/haiku/i.test(model)) return "haiku";
  if (/fable/i.test(model)) return "fable";
  return "sonnet";
}

/**
 * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}, truncated: boolean}>}
 */
async function generate(system, messages, model) {
  if (PROVIDER === "cli") return generateViaCli(system, messages, model);
  if (PROVIDER === "api") return generateViaApi(system, messages, model);
  return generateViaSdk(system, messages, model);
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
      maxTurns: SDK_MAX_TURNS,
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
  return {
    text: j.result ?? "",
    usage: {
      input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      output_tokens: u.output_tokens ?? 0,
    },
    truncated: j.stop_reason === "max_tokens",
  };
}

/**
 * throttle → generate → meter 記録 → 打ち切り警告。テキストを返す。
 * @param {import("./meter.js").TokenMeter} meter
 */
export async function callAgent(system, messages, model, meter) {
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
