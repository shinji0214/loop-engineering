/**
 * フェーズ1: 決定的チェック失敗 → Code Reviewer を呼ばず即REJECT。
 * R1: CJS-in-ESM の壊れたコード → checks NG → 自動REJECT
 * R2: 正しい ESM → checks OK → Reviewer APPROVE
 * Reviewer の呼び出しが「1回だけ」なら OK。
 */
import http from "node:http";

const ENTRY = new URL("../../index.js", import.meta.url).href;

let call = 0;
let reviewerCalls = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    call++;
    const isReviewer = body.includes("コードレビュアー");
    let text;
    if (isReviewer) {
      reviewerCalls++;
      text = "APPROVE";
    } else {
      const devCall = call - reviewerCalls;
      text =
        devCall === 1
          ? '```package.json\n{"type":"module"}\n```\n```src/index.js\nconst x = require("./util.js");\nmodule.exports = x;\n```'
          : "```src/index.js\nexport const x = 1;\n```";
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
  process.env.MAX_ROUNDS = "3";
  process.env.CHECKS = "1";

  const { runLoop } = await import(ENTRY);
  const r = await runLoop("dummy");
  server.close();
  const ok = r.status === "approved" && reviewerCalls === 1;
  console.log(ok ? "OK: R1はcheck失敗で自動REJECT(Reviewer未呼出)" : `FAIL: status=${r.status} reviewerCalls=${reviewerCalls}`);
  process.exit(ok ? 0 : 1);
});
