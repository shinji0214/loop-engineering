/**
 * 変更ファイルのみ＋累積マージの検証。
 * R1: 2ファイル出力→REJECT / R2: 1ファイル修正→REJECT / R3: delete→APPROVE
 * 最終成果物に「R1のもう1ファイル」が元の内容のまま残っていれば累積成功。
 */
import http from "node:http";

const ENTRY = new URL("../../index.js", import.meta.url).href;

let call = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    call++;
    const isReviewer = call % 2 === 0;
    let text;
    if (isReviewer) {
      text = call / 2 < 3 ? "REJECT\n- src/a.js が要件未達（該当: src/a.js）" : "APPROVE";
    } else {
      const round = (call + 1) / 2;
      if (round === 1) {
        text = "```src/a.js\nexport const a = 1;\n```\n```src/b.js\nexport const b = 2; // 触らない\n```";
      } else if (round === 2) {
        text = "```src/a.js\nexport const a = 100;\n```";
      } else {
        text = "```delete\nsrc/a.js\n```";
      }
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
  process.env.CHECKS = "0";

  const { runLoop } = await import(ENTRY);
  const r = await runLoop("dummy task");
  server.close();

  const paths = r.files.map((f) => f.path).sort();
  const bFile = r.files.find((f) => f.path === "src/b.js");
  const ok =
    JSON.stringify(paths) === JSON.stringify(["src/b.js"]) &&
    bFile?.content.includes("触らない");
  console.log(ok ? "OK: 累積マージ＆削除が機能" : `FAIL: files=${JSON.stringify(paths)}`);
  process.exit(ok ? 0 : 1);
});
