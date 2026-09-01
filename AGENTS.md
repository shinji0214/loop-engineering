# エージェント役割定義（STEP 1 成果物）

> 実行は既定で **Claude Agent SDK**（`@anthropic-ai/claude-agent-sdk` の `query()`）経由。
> `claude` のサブスク（Pro/Max）ログインをそのまま使うので Anthropic API キーは不要。
> `LOOP_PROVIDER` で `cli`（`claude -p` サブプロセス）/ `api`（APIキー直叩き）にも切替可。

> エージェントは最大4体（`TESTS=1` のとき）: Test Writer / Test Reviewer /
> Developer / Code Reviewer。既定（`TESTS=0`）は Developer / Code Reviewer の2体。

## Test Writer Agent（`TESTS=1` のとき）

- **役割**: コード生成の前に、タスクと入出力例（アンカー）から受け入れテストを作る
- **モデル**: `claude-sonnet-5`（`TEST_WRITER_MODEL`）
- **出力**: `test/REQUIREMENTS.md`（検証可能な要件の番号付き列挙＋エントリパス）と
  `test/acceptance.test.js`（`node:test`。各要件に最低1テスト、アンカーは逐語）
- テスト不可なタスクは「テスト不可: 理由」を返す

## Test Reviewer Agent（`TESTS=1` のとき）

- **役割**: Test Writer の出力を、実装前に審査する（「テストのテスト」）
- **モデル**: `claude-sonnet-5`（`TEST_REVIEWER_MODEL`）
- **REJECT 条件**: 要件列挙が不忠実 / カバレッジ不足（テストの無い要件）/
  アンカー不整合 / 実装詳細を過剰に assert / モック使用 / テストが壊れている
- APPROVE で**テストを凍結**（`runs/<セッションID>/tests/`）。以降 Developer は変更不可

## Developer Agent

- **役割**: ユーザーから与えられたタスクを満たすコードを実装する
- **モデル**: `claude-sonnet-5`
- **System Prompt**（要旨。実体は `index.js` の `DEVELOPER_SYSTEM`）:
  ```
  あなたは実装担当のエンジニアAIです。
  与えられた要件を満たすコードを動作する形で出力し、レビュー指摘は反映する。

  出力ルール:
  - 出力はコードブロックのみ（前置き・説明なし）
  - 各ブロックの言語指定の位置に「相対パス」を書く（例: ```src/index.js）
  - 1ファイルでもパスを付ける（例: ```solution.js）
  - 初回は全ファイル。2回目以降は変更したファイルだけ出力（出さないファイルは保持）
  - 削除は ```delete ブロックにパスを1行ずつ
  - パスに .. や絶対パスは使わない
  ```
- **成果物**: ループ側が各ラウンドの出力を累積 Map にマージし、最終状態を
  `output/<セッションID>/` に書き出す。未変更ファイルは再生成されないので
  トークン節約＆回帰防止になる。前回レビューで名前が出ていないファイルが
  変更されると `[Warn]` を出す（回帰ガード）。
- **遷移記録**: 各ラウンド終了時点のスナップショットを `runs/<セッションID>/round-N/` に、
  遷移サマリ（判定・変更ファイル・前回指摘への対応の表＋Reviewer 全文）を
  `runs/<セッションID>/SUMMARY.md` に生成（`SNAPSHOTS=0` で無効）。

## Code Reviewer Agent（旧 Reviewer）

- **役割**: Developer Agentの出力をレビューし、合否判定を下す
- **モデル**: `claude-sonnet-5`
  - 理想は Developer と別モデル（`claude-opus-5`）にして自己採点の甘さを防ぐこと。
    ただし Pro プランは opus の利用枠が小さく途中で枠切れするため、既定では
    Developer と同じ `claude-sonnet-5` を使う（呼び出し・system prompt は分離済み）。
  - opus の枠に余裕がある場合は `REVIEWER_MODEL=claude-opus-5` で本来の構成に戻せる。
- **入力**: 「元のタスク（要件）」＋「Developer の出力（複数ファイル可）」の両方を渡す
- **重大度ゲート**: 「あった方が良い」改善で REJECT させず、ループが無限に細かい指摘を
  出し続ける（＝収束しない）のを防ぐための仕組み。
- **System Prompt**（要旨。実体は `index.js` の `REVIEWER_SYSTEM`）:
  ```
  重大な欠陥には厳格に、些細な改善要望には寛容に判定する。

  REJECT にできるのは次のいずれかのみ:
  - 要件違反（明記された条件・エッジケース・成果物の未達）
  - 明確なバグ（ロジック誤り・クラッシュ・データ破壊）
  - セキュリティ上の問題

  次は REJECT にしない（APPROVE の上で「改善提案（対応任意）」に回す）:
  - タスクに書かれていない堅牢性強化
  - スタイル・命名・可読性・コメント/ドキュメントの細かい不一致
  - Developer が自主的に足した仕様外機能や説明不足
  - タスクに無い基準を持ち出した「不足」の主張

  出力: 先頭行に APPROVE または REJECT。REJECT は根拠項目のみ箇条書き
  （該当ファイル・箇所・理由）。判定は保留しない。
  ```

## 決定的チェック（STEP 4 フェーズ1）

Reviewer を呼ぶ前に、毎ラウンド機械チェックを通す:

- `.json` → `JSON.parse` / `.js`/`.mjs`/`.cjs` → 子プロセスで動的 `import`（読み込み確認）
- 構文エラー・モジュール解決エラー・ESM/CommonJS 不整合を検出
- **失敗 → Code Reviewer を呼ばず即 REJECT**（`verdict: REJECT`、`checks` にエラー列挙）。エラー全文を次ラウンドの Developer へ
- アプリ的な実行時例外は無視（挙動の検証はテスト実行で）
- `CHECKS=0` で無効

## 受け入れテスト実行（STEP 4 フェーズ3 / `TESTS=1` のとき）

- 決定的チェック通過後、`node --test`（凍結テスト＋現在のコード）を子プロセスで実行
- **失敗 → Code Reviewer を呼ばず即 REJECT**（`TEST_FAIL_MODE=review` で Reviewer に委任）。失敗ログを Developer へ
- 全通過 → Code Reviewer にテスト結果も渡す

## 完了基準（Acceptance Criteria）

- 決定的チェックを通過、**かつ**（`TESTS=1` なら）受け入れテスト全通過、
  **かつ** Code Reviewer の応答が `APPROVE` で始まる場合のみ「合格」
  （APPROVE の後に「改善提案（対応任意）」が続いても合格）
- それ以外は「差し戻し」として次のラウンドへ進める
- 差し戻し時、Developer には「REJECT の根拠を最優先で修正、改善提案は任意」と伝える

## 停止条件

| 条件 | 値 |
|---|---|
| 最大ラウンド数 | 5 |
| タイムアウト | 未設定（STEP 5で実装予定） |
| 人間へのエスカレーション | 最大ラウンド到達時 |
