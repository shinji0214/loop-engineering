# Multi-Agent Dev/Review System

Developer Agent と Reviewer Agent（別モデル）が交互にやり取りし、
レビュー承認まで自動でコードを改善していく最小プロトタイプ。

STEPごとの目標・完了基準は [STEPS.md](./STEPS.md) を参照。
エージェントの役割定義は [AGENTS.md](./AGENTS.md) を参照。

## 現在の実装状況

- [x] STEP 1: 役割設計（`AGENTS.md`）
- [x] STEP 2: 最小ループ実装（`index.js`）
- [ ] STEP 3: チャットツール化（UI）
- [ ] STEP 4: 証拠駆動化（テスト・lint連携）
- [~] STEP 5: 安全弁の実装（トークン上限・消費レート・自動停止は実装済み）

## セットアップ

Node.js v18以上が必要です（ESM / トップレベルawaitを使用）。

```bash
npm install
```

**基本は `sdk`（Claude Agent SDK）を使う。** 開発・検証はすべて `sdk` モード前提で、
`cli` / `api` は必要な場合のみのフォールバックです。モデルの呼び出し方は3通り、
`LOOP_PROVIDER` で切り替えます。

| provider | 位置づけ | 認証 | 課金 |
|---|---|---|---|
| `sdk`（既定・推奨） | **通常はこれ** | `claude` のログイン（Claude Pro/Max のサブスク） | サブスクの利用上限を消費 |
| `cli` | SDK が動かない環境向けフォールバック | 同上（`claude -p` をサブプロセスで叩く。`CLAUDE_CLI_PATH` 可）| 同上 |
| `api` | APIキーで動かしたいとき（配布時など）| `ANTHROPIC_API_KEY` | Anthropic API（Proとは別クレジット）|

`sdk` / `cli` モードは Anthropic API キーもクレジットも不要で、手元の `claude`
（Claude Code）のサブスクリプション認証をそのまま使う。`sdk` は
`@anthropic-ai/claude-agent-sdk` の `query()` 経由。事前に `claude` でログインしておくこと。

> ⚠️ Agent SDK のサブスク認証を「自作プロダクトの機能として他人に提供」するのは
> Anthropic の規約上NG。手元の個人利用に限る（配布するなら `api` モード）。

## 実行方法

```bash
# 既定（sdk モード）。事前に `claude` でログイン済みであること
node index.js "FizzBuzzを実装するJavaScript関数を書いて"

# Anthropic API キーで動かす場合
LOOP_PROVIDER=api node index.js "FizzBuzzを実装するJavaScript関数を書いて"
```

実行すると、Developer Agentが実装 → Reviewer Agentがレビュー、を
Reviewerが「APPROVE」を出すか最大5ラウンドに達するまで繰り返します。

### 出力される3つのディレクトリ

| パス | 中身 | 用途 |
|---|---|---|
| `output/<セッションID>/` | 最終成果物のファイルツリー | そのまま実行・検証する |
| `runs/<セッションID>/round-N/` | 各ラウンド終了時点のファイルツリー（スナップショット）| `diff -r round-1 round-2` でどのラウンドで何が変わったか追う |
| `runs/<セッションID>/SUMMARY.md` | 遷移サマリ（判定・変更ファイル・前回指摘への対応の表＋各ラウンドの Reviewer 全文）| 後から人間が読む／ループの品質評価 |
| `logs/<セッションID>.jsonl` | 機械可読ログ（毎ラウンド＋finish を追記）| 派生ビューの元データ |

スナップショット/サマリは `SNAPSHOTS=0` で無効化できます。

### 既存コードの入力（`FROM_DIR`）

```bash
$env:FROM_DIR = "output\2026-09-01T..."; node index.js "既存プロジェクトへの改修内容"; Remove-Item Env:FROM_DIR
```

`FROM_DIR` に既存のファイルツリーを指定すると、それを `currentFiles` の初期値として読み込み、
ゼロから作るのではなく**既存コードの改修**として動く（1ラウンド目から「変更するファイルだけ出力」）。
`node_modules` / `.git` / `output` / `runs` / `logs` / `.loop-tmp` / ドットファイルは自動で除外するので、
プロジェクトルート（`.`）を指しても安全。自己編集・リファクタタスクに使う。

### 成果物（複数ファイル対応）

Developer は複数ファイルを出力できます（コードブロックの言語指定の位置に
相対パスを書く: <code>\`\`\`src/index.js</code>）。

- **初回は全ファイル、2回目以降は変更したファイルだけ**を出力。ループ側が
  ラウンドごとの出力を累積マージするので、未変更ファイルは再生成されない
  （＝出力トークン節約＆再生成による回帰の防止）。
- 削除は <code>\`\`\`delete</code> ブロックにパスを1行ずつ書く。
- 前回レビューで名前が出ていないファイルが変更されると `[Warn]` を出す（回帰ガード）。
- 最終状態が **`output/<セッションID>/`** 以下に実ファイルとして書き出されます。
- パス付きコードブロックが1つも無い場合は書き出さず、生出力だけ表示します。

Reviewer には元のタスク文（要件）も渡されるので、「バグは無いが要件未達」
も判定できます。

### 決定的チェック（STEP 4 フェーズ1）

毎ラウンド、Developer の出力を子プロセスで機械チェックします:

- `.json` は `JSON.parse`、`.js` / `.mjs` / `.cjs` は動的 `import` で**読み込み確認**
- 構文エラー / モジュール解決エラー / **ESM・CommonJS の不整合** を検出
- 失敗したら **Reviewer を呼ばずに即 REJECT**（トークン節約）、エラー全文を次ラウンドの Developer に渡す
- アプリ的な実行時例外はここでは無視（挙動の検証はテスト実行で）

`CHECKS=0` で無効化。

### 受け入れテスト（STEP 4 フェーズ2-3 / 既定 OFF・`TESTS=1` で有効）

コード生成の**前**に、テストを確定してから実装ループを回します:

1. **Test Writer** … タスク文と入出力例（アンカー）から「検証可能な要件」を列挙 ＋ `node:test` の
   受け入れテスト（`test/acceptance.test.js`）を生成。アンカーは逐語でテスト化
2. **Test Reviewer** … 要件列挙の忠実性 / 全要件にテストがあるか / アンカー整合 / 過剰モックを審査
3. APPROVE で**テストを凍結**（`runs/<セッションID>/tests/`）。以降 Developer はテストを変更できない
4. 実装ループの毎ラウンド、決定的チェック通過後に `node --test` を実行
   - 失敗 → **Code Reviewer を呼ばず即 REJECT**（`TEST_FAIL_MODE=review` で Reviewer に委ねる）
   - 全通過 → Code Reviewer にテスト結果も渡してレビュー

テスト不可なタスク（主観的・数値化不能）は Test Writer が「テスト不可」を返し、フェーズ1＋Reviewer のみで進みます。

### トークンの安全弁（環境変数で調整）

| 変数 | 既定値 | 意味 |
|---|---|---|
| `TOKEN_BUDGET` | `100000` | ループ全体の合計消費（入力+出力）上限。到達すると `budget_exceeded` で自動停止 |
| `TOKENS_PER_MINUTE` | `40000` | 消費スピード上限。直近60秒の消費がこれを超えると次の呼び出しを待機（`0` で無効） |
| `MAX_BUDGET_USD` | `0`（無効） | 1回の生成のコスト上限(USD)。**`sdk` モードのみ**（SDK の `maxBudgetUsd`）|
| `MAX_OUTPUT_TOKENS` | `8000` | 1回の生成の最大出力トークン数。**`api` モードのみ強制**、`sdk`/`cli` は参考値 |
| `MAX_ROUNDS` | `5` | 最大ラウンド数 |
| `DEVELOPER_MODEL` / `REVIEWER_MODEL` | どちらも `claude-sonnet-5` | 各エージェントのモデル |
| `LOOP_PROVIDER` | `sdk` | `sdk` / `cli` / `api` |
| `CLAUDE_CLI_PATH` | `claude` | `cli` モードで使う実行ファイル |
| `VERBOSE` | `0` | `1` で Developer の生成コードを毎ラウンド全文表示。既定はファイル名＋行数のみ（全文は `output/` と `logs/`）|
| `SNAPSHOTS` | `1` | `0` で `runs/<セッションID>/`（ラウンドごとのスナップショット＋`SUMMARY.md`）を作らない |
| `CHECKS` | `1` | `0` で決定的チェック（構文・読み込み）を無効化 |
| `CHECK_TIMEOUT_MS` | `15000` | チェック子プロセスのタイムアウト |
| `TESTS` | `0` | `1` で受け入れテスト（Test Writer/Reviewer ＋ `node --test`）を有効化 |
| `TEST_MAX_ROUNDS` | `2` | テスト確定フェーズの最大ラウンド |
| `TEST_TIMEOUT_MS` | `30000` | `node --test` のタイムアウト |
| `TEST_FAIL_MODE` | `reject` | `reject`=テスト失敗で即REJECT / `review`=Code Reviewer に渡す |
| `TEST_WRITER_MODEL` / `TEST_REVIEWER_MODEL` | `claude-sonnet-5` | 各エージェントのモデル |
| `FROM_DIR` | （空）| 既存ファイルツリーを読み込んで改修対象にする（未指定ならゼロから新規作成）|

```bash
TOKEN_BUDGET=200000 TOKENS_PER_MINUTE=60000 MAX_BUDGET_USD=0.5 node index.js "タスク"
```

> - `sdk` / `cli` モードでは `claude` 本体のシステムプロンプト分（初回だけ数万トークン）が
>   消費量に乗るので、`TOKEN_BUDGET` は `api` モードより大きめに。
>   使い回し（cache_read）分は計測から除外している。
> - モデル指定は `sonnet` / `opus` / `haiku` / `fable` のエイリアスに丸められる。
>   Pro プランでは `opus` の利用枠が小さいため、Developer / Reviewer とも既定は
>   `claude-sonnet-5`。opus の枠に余裕があれば `REVIEWER_MODEL=claude-opus-5` に
>   戻すと自己採点の甘さを避けやすい。

`index.js` は `runLoop()` を `export` しているので、STEP 3では
Expressなどからそのまま `import { runLoop } from "./index.js"` して
呼び出せます。

## 次にやること

`STEPS.md` のSTEP 3（チャットUI化）に進み、このループをブラウザから
実行できるようにする（Express + シンプルなフロントを想定）。
