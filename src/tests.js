/** STEP 4 フェーズ2-3: 受け入れテスト（Test Writer / Test Reviewer / node --test）。 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  TMP_DIR, TEST_MAX_ROUNDS, TEST_TIMEOUT_MS, TEST_WRITER_MODEL, TEST_REVIEWER_MODEL,
} from "./config.js";
import { TEST_WRITER_SYSTEM, TEST_REVIEWER_SYSTEM } from "./prompts.js";
import { callAgent } from "./providers.js";
import { mergeFiles, renderFiles, filesFromMap, writeFileTree } from "./files.js";

/** タスク文からアンカー（入出力例らしき行）を抜き出して整形。 */
export function extractAnchors(task) {
  const lines = task
    .split(/\n|。/)
    .map((s) => s.trim())
    .filter((s) => /例|=>|->|→|とき|なら|返す|出力/.test(s) && s.length > 3);
  return lines.length
    ? lines.map((l) => `- ${l}`).join("\n")
    : "(タスク本文から自動抽出できず。本文全体をアンカー候補とする)";
}

/**
 * コード生成前に受け入れテストを確定・凍結する（フェーズ2）。
 * @returns {Promise<{testFiles: Map<string,string>, requirements: string, status: "approved"|"unreviewed"|"untestable"}>}
 */
export async function establishTests(task, meter) {
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
    console.log(
      `[TestWriter] ${testCount}個のテストファイル / 要件 ${reqFile.split("\n").filter((l) => /^\s*\d/.test(l)).length} 件`
    );

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
export async function runTests(sessionId, roundNum, codeMap, testMap) {
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
    return {
      ok: false,
      summary: `テストが ${Math.round(TEST_TIMEOUT_MS / 1000)} 秒でタイムアウト`,
      output: raw.slice(0, 2000),
    };
  }
  const pass = Number((raw.match(/^# pass (\d+)/m) || [])[1] || 0);
  const fail = Number((raw.match(/^# fail (\d+)/m) || [])[1] || 0);
  const ok = res.codeExit === 0 && fail === 0 && pass > 0;
  const summary =
    pass + fail > 0 ? `pass ${pass} / fail ${fail}` : `テスト実行エラー（exit ${res.codeExit}）`;
  const detail = ok
    ? ""
    : raw
        .split("\n")
        .filter((l) => /^not ok|^\s*(expected|actual|message|error):|AssertionError|Error:|要件\d/.test(l))
        .slice(0, 40)
        .join("\n");
  return { ok, summary, output: (detail || raw).slice(0, 2500) };
}
