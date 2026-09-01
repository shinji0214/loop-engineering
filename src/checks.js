/** STEP 4 フェーズ1: 決定的チェック（構文＋読み込み確認）。 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TMP_DIR, CHECK_TIMEOUT_MS } from "./config.js";
import { writeFileTree, filesFromMap } from "./files.js";

// チェック用ディレクトリに配置して子プロセスで実行するドライバ。
// .json は JSON.parse、.js/.mjs/.cjs は動的 import で読み込み確認。
// import はモジュール本体を実行するので CLI エントリの process.exit を無効化する。
// 「読み込みエラー」（構文・モジュール解決・ESM/CJS 不整合）だけを問題として報告し、
// アプリ的な実行時例外は無視する（挙動の検証はフェーズ3のテスト実行で）。
const CHECK_DRIVER = `
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const absRoot = path.resolve(root);
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "_loopcheck.mjs" || e.name.startsWith(".")) continue;
    const p = path.join(d, e.name);
    e.isDirectory() ? walk(p) : files.push(p);
  }
})(root);

const rel = (p) => path.relative(root, p).replace(/\\\\/g, "/");
const scrub = (s) => String(s).split("\\n")[0].split(absRoot).join("").split(absRoot.replace(/\\\\/g, "/")).join("").replace(/\\\\/g, "/").replace(/^[\\/]+/, "");
const problems = [];
const add = (m) => { if (!problems.includes(m)) problems.push(m); };

const LOAD_ERR = /Cannot use import statement|require is not defined|exports is not defined|module is not defined|__dirname is not defined|__filename is not defined|Unexpected (token|identifier|end of)|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|ERR_UNSUPPORTED_DIR_IMPORT|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_UNSUPPORTED_ESM_URL_SCHEME/;

process.exit = () => {}; // import 時に走る CLI エントリの exit を無効化

for (const f of files) {
  const ext = path.extname(f);
  const r = rel(f);
  if (ext === ".json") {
    try { JSON.parse(fs.readFileSync(f, "utf8")); }
    catch (e) { add(r + ": 不正なJSON — " + e.message); }
    continue;
  }
  if (![".js", ".mjs", ".cjs"].includes(ext)) continue;
  try {
    await import(pathToFileURL(f).href + "?t=" + Date.now());
  } catch (e) {
    const tag = (e && (e.name + " " + (e.code || "") + " " + e.message)) || String(e);
    if (e instanceof SyntaxError || LOAD_ERR.test(tag)) {
      add(r + ": 読み込み失敗 — " + scrub(e.message || tag));
    }
  }
}

console.log("__LOOPCHECK__" + JSON.stringify(problems));
`;

/**
 * 累積ファイルを一時ディレクトリに書き出し、子プロセスで構文＋読み込みチェック。
 * @returns {Promise<{ok: boolean, problems: string[]}>}
 */
export async function runChecks(sessionId, roundNum, fileMap) {
  const base = path.join(TMP_DIR, `checks-${sessionId}`);
  const dir = path.join(base, `round-${roundNum}`);
  fs.rmSync(dir, { recursive: true, force: true });
  writeFileTree(dir, filesFromMap(fileMap));
  fs.writeFileSync(path.join(dir, "_loopcheck.mjs"), CHECK_DRIVER, "utf-8");

  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["_loopcheck.mjs", "."], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CHECK_TIMEOUT_MS,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ err: `spawn error: ${e.message}` }));
    child.on("close", (codeExit, signal) => resolve({ out, err, codeExit, signal }));
  });

  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* noop */
  }

  if (res.signal) {
    return {
      ok: false,
      problems: [
        `チェックが ${Math.round(CHECK_TIMEOUT_MS / 1000)} 秒でタイムアウト（無限ループ / 未解決の top-level await の可能性）`,
      ],
    };
  }
  const marker = (res.out || "").split("\n").find((l) => l.startsWith("__LOOPCHECK__"));
  if (marker) {
    try {
      const problems = JSON.parse(marker.slice("__LOOPCHECK__".length));
      return { ok: problems.length === 0, problems };
    } catch {
      /* fall through */
    }
  }
  return {
    ok: false,
    problems: [`チェック実行に失敗: ${(res.err || res.out || "unknown").slice(0, 400)}`],
  };
}
