import fs from "node:fs";
import path from "node:path";
import { FROM_DIR_EXCLUDE } from "./config.js";

/** 言語指定の位置がパスっぽい（/ を含む、または末尾が拡張子）か。 */
export function looksLikePath(info) {
  if (!info) return false;
  return /[\\/]/.test(info) || /\.[A-Za-z0-9]{1,8}$/.test(info);
}

/**
 * Developer の出力テキストから ```相対パス ... ``` のブロックを抜き出す。
 * パス付きブロックが1つも無ければ [] を返す（＝ファイル書き出しはしない）。
 * 制約: ファイル内容自体に ``` 行が含まれる場合（Markdown等）はそこで途切れる。
 * @param {string} text
 * @returns {{path: string, content: string}[]}
 */
export function parseFiles(text) {
  const files = [];
  const fence = /^```([^\n`]*)\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
  let m;
  while ((m = fence.exec(text)) !== null) {
    const info = m[1].trim();
    if (!looksLikePath(info)) continue;
    files.push({ path: info.replace(/\\/g, "/"), content: m[2] });
  }
  return files;
}

/**
 * Developer 出力から削除指示（```delete ... ``` ブロック）を抜き出す。
 * @param {string} text
 * @returns {string[]} 削除対象の相対パス
 */
export function parseDeletes(text) {
  const out = [];
  const fence = /^```delete[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
  let m;
  while ((m = fence.exec(text)) !== null) {
    for (const line of m[1].split("\n")) {
      const p = line.trim().replace(/\\/g, "/");
      if (p) out.push(p);
    }
  }
  return out;
}

/** 累積ファイル Map を Developer / Reviewer に読ませる1つのテキストへ整形。 */
export function renderFiles(fileMap) {
  return [...fileMap.entries()]
    .map(([p, content]) => "```" + p + "\n" + content + "\n```")
    .join("\n\n");
}

/**
 * Developer の今回の出力を累積ファイル Map にマージする。
 * isProtected(path) が真のパスは Developer が出力しても取り込まず無視する
 * （凍結テスト等、既存のまま保持したいファイル）。
 * @param {Map<string,string>} fileMap - 破壊的に更新される
 * @param {string} code
 * @param {(path: string) => boolean} [isProtected]
 * @returns {{changed: string[], deleted: string[], ignored: string[]}}
 */
export function mergeFiles(fileMap, code, isProtected) {
  const changed = [];
  const ignored = [];
  for (const f of parseFiles(code)) {
    if (isProtected && isProtected(f.path)) {
      ignored.push(f.path);
      continue;
    }
    if (fileMap.get(f.path) !== f.content) changed.push(f.path);
    fileMap.set(f.path, f.content);
  }
  const deleted = [];
  for (const p of parseDeletes(code)) {
    if (isProtected && isProtected(p)) {
      ignored.push(p);
      continue;
    }
    if (fileMap.delete(p)) deleted.push(p);
  }
  return { changed, deleted, ignored };
}

/** base の外に出ないよう相対パスを解決する。ダメなら例外。 */
export function safeResolve(base, rel) {
  const resolved = path.resolve(base, rel);
  const rootWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (resolved !== base && !resolved.startsWith(rootWithSep)) {
    throw new Error(`不正なファイルパス: ${rel}`);
  }
  return resolved;
}

/**
 * ファイル群を dir 以下に実書き出しする（パスは dir の外に出られない）。
 * @returns {string|null} 書き出し先ディレクトリ（ファイルが無ければ null）
 */
export function writeFileTree(dir, files) {
  if (!files.length) return null;
  for (const f of files) {
    const dest = safeResolve(dir, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.content, "utf-8");
  }
  return dir;
}

/**
 * dir 以下を再帰的に読み込み、相対パス -> 内容 の Map を返す（既存コード入力用）。
 * FROM_DIR_EXCLUDE に載っている名前・ドットファイル/ディレクトリ・バイナリ疑いはスキップ。
 * @param {string} dir
 * @returns {Map<string,string>}
 */
export function readFileTree(dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  const root = path.resolve(dir);
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || FROM_DIR_EXCLUDE.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(root, full).replace(/\\/g, "/");
      const buf = fs.readFileSync(full);
      if (buf.includes(0)) continue; // バイナリらしきものは無視
      out.set(rel, buf.toString("utf-8"));
    }
  })(root);
  return out;
}

/** Map<path,content> を {path,content}[] に。 */
export function filesFromMap(fileMap) {
  return [...fileMap.entries()].map(([p, content]) => ({ path: p, content }));
}
