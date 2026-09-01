/**
 * Multi-Agent Dev/Review System — エントリポイント
 *
 * Developer / Reviewer の2エージェント（+ TESTS=1 で Test Writer / Test Reviewer）が
 * 交互にやり取りし、Reviewer が APPROVE を出すか最大ラウンド数に達するまで
 * コードの生成・修正を繰り返す。
 *
 * ロジックは src/ に分割:
 *   src/config.js    環境変数から読む設定
 *   src/prompts.js   各エージェントの system prompt
 *   src/meter.js     TokenMeter（予算 / レート制限）
 *   src/providers.js sdk / cli / api のモデル呼び出し + callAgent
 *   src/files.js     コードブロックのパース / 累積マージ / 読み書き
 *   src/checks.js    フェーズ1: 決定的チェック（構文 + 読み込み）
 *   src/tests.js     フェーズ2-3: 受け入れテスト（Test Writer / Reviewer / node --test）
 *   src/summary.js   遷移サマリ SUMMARY.md の生成
 *   src/loop.js      runLoop（オーケストレーション）
 *
 * ■ 実行方法（既定は sdk。LOOP_PROVIDER で切り替え）
 *   1. sdk : Claude Agent SDK 経由。`claude` のサブスク（Pro/Max）ログインを使う。APIキー不要
 *   2. cli : `claude -p` をサブプロセスで叩く（sdk が動かない環境向け）
 *   3. api : Anthropic API 直叩き（ANTHROPIC_API_KEY 必要）
 *
 * ※ Agent SDK のサブスク認証を「自作プロダクトの機能として他人に提供」するのは
 *   Anthropic の規約上NG。手元の個人利用に限る（配布するなら api モード）。
 *
 * 詳細は README.md / AGENTS.md / STEPS.md。
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { VERBOSE } from "./src/config.js";
import { runLoop } from "./src/loop.js";

// 公開API（test/mocks や外部から import される）
export { runLoop } from "./src/loop.js";
export { parseFiles } from "./src/files.js";
export { runChecks } from "./src/checks.js";
export { runTests, establishTests } from "./src/tests.js";

async function main() {
  const task = process.argv[2];
  if (!task) {
    console.log('使い方: node index.js "タスクの説明"');
    process.exit(1);
  }

  const { code, files, outputDir, runsDir, status, tests, usage } = await runLoop(task);

  console.log("\n" + "=".repeat(50));
  console.log(`最終ステータス: ${status}`);
  console.log(`消費トークン: ${usage.total}（入力 ${usage.input} / 出力 ${usage.output}）`);
  if (tests && tests.status !== "off") {
    console.log(`受け入れテスト: ${tests.status}（${tests.files.join(", ") || "なし"}）`);
  }
  if (runsDir) console.log(`遷移サマリ: ${path.join(runsDir, "SUMMARY.md")}`);
  if (outputDir) {
    console.log(`成果物: ${outputDir}`);
    for (const f of files) console.log(`  - ${f.path}`);
    if (VERBOSE) {
      console.log("=".repeat(50));
      console.log(code);
    }
  } else {
    console.log("成果物: パス付きコードブロックが無かったため未書き出し（生出力を表示）");
    console.log("=".repeat(50));
    console.log(code);
  }

  if (status !== "approved") process.exitCode = 1;
}

// このファイルが直接実行された場合のみ main() を走らせる（import 時は走らせない）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`\n[Error] ${e?.message || e}`);
    process.exit(1);
  });
}
