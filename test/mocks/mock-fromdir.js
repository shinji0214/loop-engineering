/**
 * FROM_DIR（既存コード入力）の検証:
 *  種ディレクトリに a.js / b.js。Developer は a.js だけ変更 → APPROVE。
 *  最終成果物に a.js（変更版）と b.js（元のまま）の両方が残るか。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const ENTRY = new URL("../../index.js", import.meta.url).href;

let devSawExisting = false;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let text;
    if (body.includes("コードレビュアー")) {
      text = "APPROVE";
    } else {
      if (body.includes("現在のプロジェクト（既存コード") && body.includes("export const b")) {
        devSawExisting = true;
      }
      text = "```a.js\nexport const a = 100; // updated\n```";
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
  const seedDir = fs.mkdtempSync(path.join(tmpdir(), "seed-"));
  fs.writeFileSync(path.join(seedDir, "a.js"), "export const a = 1; // original\n");
  fs.writeFileSync(path.join(seedDir, "b.js"), "export const b = 2; // untouched\n");

  process.env.LOOP_PROVIDER = "api";
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.ANTHROPIC_API_KEY = "sk-ant-mock";
  process.env.TOKEN_BUDGET = "0";
  process.env.TOKENS_PER_MINUTE = "0";
  process.env.MAX_ROUNDS = "2";
  process.env.CHECKS = "0";
  process.env.FROM_DIR = seedDir;

  const { runLoop } = await import(ENTRY);
  const r = await runLoop("a.js の値を100にして");
  server.close();
  fs.rmSync(seedDir, { recursive: true, force: true });

  const aFile = r.files.find((f) => f.path === "a.js");
  const bFile = r.files.find((f) => f.path === "b.js");
  const ok =
    r.status === "approved" &&
    devSawExisting &&
    aFile?.content.includes("updated") &&
    bFile?.content.includes("untouched");
  console.log(ok ? "OK: FROM_DIR で既存を読み込み、未変更分は保持" : `FAIL: status=${r.status} sawExisting=${devSawExisting} a=${aFile?.content?.trim()} b=${bFile?.content?.trim()}`);
  process.exit(ok ? 0 : 1);
});
