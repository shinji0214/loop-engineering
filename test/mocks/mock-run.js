/**
 * オフラインのモックAPIサーバに向けて runLoop を実際に走らせ、
 * トークン予算超過での自動停止を確認する。
 */
import http from "node:http";

const ENTRY = new URL("../../index.js", import.meta.url).href;

let callCount = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    callCount++;
    const isReviewer = callCount % 2 === 0;
    const text = isReviewer
      ? "REJECT\n- 該当箇所: 全体 / 理由: テスト用に常に差し戻す"
      : "```js\nfunction fizzbuzz(n){return n}\n```";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model: "mock",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 8000, output_tokens: 8000 },
      })
    );
  });
});

server.listen(0, async () => {
  const port = server.address().port;
  process.env.LOOP_PROVIDER = "api";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.ANTHROPIC_API_KEY = "sk-ant-mock";
  process.env.TOKEN_BUDGET = "50000";
  process.env.TOKENS_PER_MINUTE = "0";
  process.env.MAX_ROUNDS = "5";
  process.env.CHECKS = "0";

  const { runLoop } = await import(ENTRY);
  const result = await runLoop("FizzBuzzを書いて");
  server.close();

  if (result.status !== "budget_exceeded") {
    console.error("FAIL: budget_exceeded で止まるはずが", result.status);
    process.exit(1);
  }
  console.log("OK: 予算超過で自動停止");
});
