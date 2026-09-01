/**
 * runTests が前提にしている `node --test` の出力契約を確認する。
 * （# pass / # fail のパースと exit code）
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function run(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "rt-"));
  for (const [p, c] of Object.entries(files)) {
    const full = path.join(dir, p);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, c);
  }
  const r = spawnSync(process.execPath, ["--test", "test/"], { cwd: dir, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  const raw = `${r.stdout}\n${r.stderr}`;
  const pass = Number((raw.match(/^# pass (\d+)/m) || [])[1] || 0);
  const fail = Number((raw.match(/^# fail (\d+)/m) || [])[1] || 0);
  return { ok: r.status === 0 && fail === 0 && pass > 0, pass, fail };
}

const T = "import test from 'node:test';\nimport assert from 'node:assert';\nimport { add } from '../src/index.js';\ntest('add', () => { assert.equal(add(2,3), 5); });\n";

let fail = 0;
const check = (name, cond) => {
  console.log(`  ${cond ? "ok" : "NG"}  ${name}`);
  if (!cond) fail++;
};

check("正しいコード → ok", run({ "src/index.js": "export const add=(a,b)=>a+b;\n", "test/a.test.js": T }).ok === true);

const bug = run({ "src/index.js": "export const add=(a,b)=>a-b;\n", "test/a.test.js": T });
check("バグあり → not ok, fail>0", bug.ok === false && bug.fail > 0);

check("壊れたテスト → not ok", run({ "src/index.js": "export const add=(a,b)=>a+b;\n", "test/a.test.js": "not valid {{{\n" }).ok === false);

console.log(fail ? `FAIL: ${fail}件` : "OK: node --test の出力契約が想定どおり");
process.exit(fail ? 1 : 0);
