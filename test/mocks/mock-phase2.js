/**
 * フェーズ2-3 全体（オフライン）:
 *  TestWriter → TestReviewer(APPROVE) → 凍結
 *  Dev R1: バグ → node --test 失敗 → 自動REJECT（CodeReviewer 未呼出）
 *  Dev R2: 修正 → テスト通過 → CodeReviewer(APPROVE)
 */
import http from "node:http";

const ENTRY = new URL("../../index.js", import.meta.url).href;

let codeReviewerCalls = 0;
let devCalls = 0;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let text = "";
    if (body.includes("テスト作成担当")) {
      text = [
        "```test/REQUIREMENTS.md",
        "1. double(n) は n を2倍にして返す",
        "エントリ: ../src/index.js",
        "```",
        "```test/acceptance.test.js",
        "import test from 'node:test';",
        "import assert from 'node:assert';",
        "import { double } from '../src/index.js';",
        "test('要件1: 2倍', () => { assert.equal(double(3), 6); });",
        "```",
      ].join("\n");
    } else if (body.includes("テストレビュアー")) {
      text = "APPROVE";
    } else if (body.includes("コードレビュアー")) {
      codeReviewerCalls++;
      text = "APPROVE";
    } else {
      devCalls++;
      text =
        devCalls === 1
          ? "```src/index.js\nexport const double = (n) => n + n + 1;\n```"
          : "```src/index.js\nexport const double = (n) => n * 2;\n```";
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "m",
        type: "message",
        role: "assistant",
        model: "mock",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 10 },
      })
    );
  });
});

server.listen(0, async () => {
  const port = server.address().port;
  process.env.LOOP_PROVIDER = "api";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.ANTHROPIC_API_KEY = "sk-ant-mock";
  process.env.TOKEN_BUDGET = "0";
  process.env.TOKENS_PER_MINUTE = "0";
  process.env.MAX_ROUNDS = "4";
  process.env.TESTS = "1";

  const { runLoop } = await import(ENTRY);
  const r = await runLoop("double(n) が n を2倍にする関数を src/index.js に。例: double(3) => 6");
  server.close();
  const ok =
    r.status === "approved" &&
    r.tests.status === "approved" &&
    codeReviewerCalls === 1 && // R1 は自動REJECTで呼ばれない
    devCalls === 2;
  console.log(
    ok
      ? "OK: TestWriter→凍結→テスト失敗で自動REJECT→修正→APPROVE"
      : `FAIL: status=${r.status} tests=${r.tests.status} CR=${codeReviewerCalls} Dev=${devCalls}`
  );
  process.exit(ok ? 0 : 1);
});
