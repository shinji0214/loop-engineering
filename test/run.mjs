/**
 * 凍結オラクル・ランナー。
 *
 *   node test/run.mjs           # mocks/ の通常テスト + generations/ を実行
 *   SLOW=1 node test/run.mjs    # *.slow.* も含める（レート制限テスト等、~60秒）
 *
 * - test/mocks/            : スタンドアロンの統合テスト（exit 0 = pass）
 * - test/generations/      : 承認された世代の受け入れテスト（node --test で拾う .test.js）
 *
 * 生成物（logs/output/runs/.loop-tmp）は LOOP_ARTIFACT_ROOT で一時ディレクトリに隔離する。
 * いずれか1つでも失敗したら exit 1。
 */
import { readdirSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCKS_DIR = path.join(HERE, "mocks");
const GEN_DIR = path.join(HERE, "generations");
const SLOW = /^(1|true|yes|on)$/i.test(process.env.SLOW || "");

const artifactRoot = mkdtempSync(path.join(tmpdir(), "loop-oracle-"));
const childEnv = { ...process.env, LOOP_ARTIFACT_ROOT: artifactRoot };

/** @type {{name:string, ok:boolean, ms:number, tail:string}[]} */
const results = [];

function runScript(file) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file], { env: childEnv, encoding: "utf8", timeout: 180_000 });
  const ms = Date.now() - t0;
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
  const tail = out.split("\n").filter(Boolean).slice(-1)[0] || "(出力なし)";
  return { ok: r.status === 0, ms, tail };
}

// 1. mocks/
const mockFiles = existsSync(MOCKS_DIR)
  ? readdirSync(MOCKS_DIR)
      .filter((f) => /\.(js|mjs)$/.test(f))
      .filter((f) => SLOW || !/\.slow\./.test(f))
      .sort()
  : [];

for (const f of mockFiles) {
  const { ok, ms, tail } = runScript(path.join(MOCKS_DIR, f));
  results.push({ name: `mocks/${f}`, ok, ms, tail });
}

// 2. generations/（承認された世代の acceptance テスト）
if (existsSync(GEN_DIR)) {
  const hasTests = (function scan(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && scan(p)) return true;
      if (e.isFile() && /\.test\.[cm]?js$/.test(e.name)) return true;
    }
    return false;
  })(GEN_DIR);

  if (hasTests) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ["--test", GEN_DIR], { env: childEnv, encoding: "utf8" });
    const ms = Date.now() - t0;
    const raw = `${r.stdout || ""}${r.stderr || ""}`;
    const pass = (raw.match(/^# pass (\d+)/m) || [])[1] || "?";
    const fail = (raw.match(/^# fail (\d+)/m) || [])[1] || "?";
    results.push({
      name: `generations/ (node --test)`,
      ok: r.status === 0,
      ms,
      tail: `pass ${pass} / fail ${fail}`,
    });
  }
}

rmSync(artifactRoot, { recursive: true, force: true });

// --- 集約 ---
console.log("");
let failed = 0;
for (const r of results) {
  const mark = r.ok ? "PASS" : "FAIL";
  if (!r.ok) failed++;
  console.log(`  ${mark}  ${r.name.padEnd(34)} ${String(r.ms).padStart(6)}ms  ${r.tail}`);
}
console.log("");
console.log(`  ${results.length - failed}/${results.length} passed${SLOW ? "" : "  （SLOW=1 で *.slow.* も実行）"}`);
process.exit(failed ? 1 : 0);
