# 自己改修バックログ

`experiments/selfimprove.mjs` が上から未完（`- [ ]`）の項目を1つずつ取り、
1世代 = 1項目 として実装させる。狭く・テスト可能な粒度で書くこと。
完了したらドライバが `- [x]` に更新する。

ロジックは `src/` に分割済み（config / prompts / meter / providers / files /
checks / tests / summary / loop）。`index.js` は薄いエントリ＋公開APIの再export。

- [ ] `src/files.js` の `parseDeletes` を拡張: `` ```delete `` のフェンス行にパスを直接書く形にも対応する。例: `parseDeletes("```delete src/old.js\n```")` は `["src/old.js"]` を返す。従来の「フェンス行の次行以降に1行ずつ」（例: `parseDeletes("```delete\nsrc/a.js\nsrc/b.js\n```")` → `["src/a.js","src/b.js"]`）も引き続き動く。両方混在も可。`parseDeletes` を `index.js` からも再export すること。

- [ ] `src/files.js` の `looksLikePath`: 拡張子の無いよく知られたファイル名（`Makefile` / `Dockerfile` / `LICENSE` / `Procfile`）もパスとみなす。例: `looksLikePath("Makefile") === true`、`looksLikePath("Dockerfile") === true`。ただし普通の言語指定（`js` / `python` / `json` / `text`）は従来どおり `false`。`looksLikePath` を `index.js` からも再export すること。

- [ ] `src/files.js` の `parseFiles`: フェンス内容自体に ``` 行が含まれても途中で切れないようにする。言語指定に4連バッククォート ```` を使えるようにし、その場合はブロック終端も ```` とする。既存の3連バッククォートの挙動は変えない。
