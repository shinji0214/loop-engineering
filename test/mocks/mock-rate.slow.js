/**
 * トークン消費レート制限（TokenMeter.throttle）の確認。
 * スライディング60秒ウィンドウを実際に待つため ~60秒かかる（.slow）。
 * TOKENS_PER_MINUTE=100 / 1呼び出し120tok → 2回目の前で待機が入る。
 */
import http from "node:http";

const ENTRY = new URL("../../index.js", import.meta.url).href;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const isReviewer = body.includes("コードレビュアー");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "m",
        type: "message",
        role: "assistant",
        model: "mock",
        content: [{ type: "text", text: isReviewer ? "APPROVE" : "```js\nok\n```" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 60, output_tokens: 60 },
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
  process.env.TOKENS_PER_MINUTE = "100";
  process.env.MAX_ROUNDS = "3";
  process.env.CHECKS = "0";

  const t0 = Date.now();
  const { runLoop } = await import(ENTRY);
  const r = await runLoop("x");
  server.close();
  const elapsed = (Date.now() - t0) / 1000;
  // dev(120tok) の後、review の前で ~60秒の待機が1回入るはず
  const ok = r.status === "approved" && elapsed >= 50 && elapsed < 120;
  console.log(ok ? `OK: レート制限で ${elapsed.toFixed(0)}s 待機した` : `FAIL: status=${r.status} elapsed=${elapsed.toFixed(1)}s`);
  process.exit(ok ? 0 : 1);
});
