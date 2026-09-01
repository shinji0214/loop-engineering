/** runChecks（決定的チェック）の単体確認。API は使わない。 */
process.env.LOOP_PROVIDER = "api";
process.env.ANTHROPIC_API_KEY = "x";
const { runChecks } = await import(new URL("../../index.js", import.meta.url).href);

const cases = [
  {
    name: "正常な ESM 2ファイル",
    files: new Map([
      ["src/util.js", "export const add = (a, b) => a + b;\n"],
      ["src/index.js", "export { add } from './util.js';\n"],
    ]),
    expectOk: true,
  },
  {
    name: "ESM プロジェクトに CommonJS(require)",
    files: new Map([
      ["package.json", '{"type":"module"}\n'],
      ["src/index.js", "const x = require('./util.js');\nmodule.exports = x;\n"],
    ]),
    expectOk: false,
  },
  {
    name: "構文エラー",
    files: new Map([["solution.js", "export function f( {\n  return 1\n}\n"]]),
    expectOk: false,
  },
  {
    name: "不正な JSON",
    files: new Map([["package.json", '{ "name": "x", }\n']]),
    expectOk: false,
  },
  {
    name: "存在しない相対 import",
    files: new Map([["src/index.js", "export { z } from './missing.js';\n"]]),
    expectOk: false,
  },
  {
    name: "CLI エントリ(import 時に process.exit)は OK 扱い",
    files: new Map([
      ["src/cli.js", "const cmd = process.argv[2];\nif (!cmd) { console.error('usage'); process.exit(1); }\nconsole.log(cmd);\n"],
    ]),
    expectOk: true,
  },
  {
    name: "アプリ的な実行時例外は無視(OK扱い)",
    files: new Map([["boom.js", "throw new Error('domain error at load');\n"]]),
    expectOk: true,
  },
];

let fail = 0;
for (const c of cases) {
  const r = await runChecks("test", 1, c.files);
  const ok = r.ok === c.expectOk;
  console.log(`  ${ok ? "ok" : "NG"}  ${c.name}`);
  if (!ok) {
    fail++;
    console.log(`      expected ok=${c.expectOk}, got`, r);
  }
}
console.log(fail ? `FAIL: ${fail}件` : "OK: runChecks 分類が正しい");
process.exit(fail ? 1 : 0);
