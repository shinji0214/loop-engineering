/** Dev/Review ループ本体（オーケストレーション）。 */
import fs from "node:fs";
import path from "node:path";
import {
  MAX_ROUNDS, PROVIDER, TOKEN_BUDGET, TOKENS_PER_MINUTE, MAX_OUTPUT_TOKENS, MAX_BUDGET_USD,
  VERBOSE, SNAPSHOTS, CHECKS, TESTS, TEST_FAIL_MODE, FROM_DIR,
  DEVELOPER_MODEL, REVIEWER_MODEL, OUTPUT_DIR, RUNS_DIR,
} from "./config.js";
import { DEVELOPER_SYSTEM, REVIEWER_SYSTEM } from "./prompts.js";
import { TokenMeter } from "./meter.js";
import { saveLog } from "./log.js";
import {
  parseFiles, renderFiles, mergeFiles, writeFileTree, readFileTree, filesFromMap,
} from "./files.js";
import { callAgent, modelAlias } from "./providers.js";
import { runChecks } from "./checks.js";
import { establishTests, runTests } from "./tests.js";
import { buildSummary } from "./summary.js";

/** Developer 出力の要約行（VERBOSE=OFF 用）。全文は logs/ と output/ にある。 */
function summarizeDevOutput(code) {
  const files = parseFiles(code);
  if (files.length) {
    return files.map((f) => `  - ${f.path} (${f.content.split("\n").length} 行)`).join("\n");
  }
  const lines = code.split("\n");
  const head = lines.slice(0, 8).join("\n");
  return lines.length > 8 ? `${head}\n  … 他 ${lines.length - 8} 行` : head;
}

/** 予算超過なら理由をログ出力して true を返す。 */
function reportBudget(meter) {
  const reason = meter.budgetExceededReason();
  if (reason) {
    console.log(`=== トークン上限に達したため自動停止: ${reason} ===`);
    return true;
  }
  return false;
}

/**
 * @param {string} task
 * @param {number} maxRounds
 * @returns {Promise<{
 *   code: string,
 *   files: {path: string, content: string}[],
 *   outputDir: string|null,
 *   runsDir: string|null,
 *   status: "approved"|"max_rounds_reached"|"budget_exceeded",
 *   tests: {status: string, files: string[]},
 *   usage: {input: number, output: number, total: number}
 * }>}
 */
export async function runLoop(task, maxRounds = MAX_ROUNDS) {
  const sessionId = new Date().toISOString().replace(/[:.]/g, "-");
  const meter = new TokenMeter({ budget: TOKEN_BUDGET, ratePerMinute: TOKENS_PER_MINUTE });
  let code = ""; // 直近ラウンドの Developer 生出力（ログ・フォールバック表示用）
  const currentFiles = new Map(); // 累積プロジェクト状態: 相対パス -> 内容
  let lastReview = null; // 前ラウンドの Reviewer 出力（回帰ガード用）
  let lastRejectWasAuto = false; // 前ラウンドが決定的ゲートによる自動REJECTか
  /** @type {{round:number, verdict:string, changed:string[], deleted:string[], review:string}[]} */
  const rounds = [];
  const runsSessionDir = path.join(RUNS_DIR, sessionId);

  if (FROM_DIR) {
    for (const [p, c] of readFileTree(FROM_DIR)) currentFiles.set(p, c);
    console.log(`[From] ${FROM_DIR} から ${currentFiles.size} 個のファイルを読み込みました`);
  }

  console.log(
    `[Config] provider=${PROVIDER} models=${modelAlias(DEVELOPER_MODEL)}/${modelAlias(REVIEWER_MODEL)} ` +
      `max_rounds=${maxRounds} token_budget=${TOKEN_BUDGET || "無制限"} ` +
      `rate=${TOKENS_PER_MINUTE || "無制限"}/分 checks=${CHECKS ? "on" : "off"} tests=${TESTS ? "on" : "off"}` +
      (FROM_DIR ? ` from=${FROM_DIR}` : "") +
      (PROVIDER === "api" ? ` max_output_tokens=${MAX_OUTPUT_TOKENS}` : "") +
      (PROVIDER === "sdk" && MAX_BUDGET_USD ? ` max_budget_usd=${MAX_BUDGET_USD}` : "")
  );

  // --- フェーズ2: コード生成前に受け入れテストを確定・凍結する ---
  let frozenTests = new Map();
  let testStatus = "off";
  if (TESTS) {
    console.log(`\n=== テスト確定フェーズ ===`);
    const est = await establishTests(task, meter);
    frozenTests = est.testFiles;
    testStatus = est.status;
    if (frozenTests.size) {
      try {
        writeFileTree(path.join(runsSessionDir, "tests"), filesFromMap(frozenTests));
        console.log(`[Tests] 凍結: ${[...frozenTests.keys()].join(", ")}`);
      } catch (e) {
        console.warn(`[Warn] テスト凍結の書き出しに失敗: ${e.message}`);
      }
    } else {
      console.log(`[Tests] テスト無しで続行（status=${testStatus}）`);
    }
    saveLog(sessionId, {
      event: "tests_established",
      status: testStatus,
      files: [...frozenTests.keys()],
      requirements: est.requirements,
      usage: meter.summary(),
    });
  }

  const devHistory = [
    {
      role: "user",
      content:
        task +
        (currentFiles.size
          ? `\n\n# 現在のプロジェクト（既存コード。変更するファイルだけ出力すること）\n${renderFiles(currentFiles)}`
          : "") +
        (frozenTests.size
          ? `\n\n# 与えられた受け入れテスト（test/ 配下・変更禁止・全て通すこと）\n${renderFiles(frozenTests)}`
          : ""),
    },
  ];

  /** 終了時の共通処理: 成果物と遷移サマリを書き出して結果オブジェクトを返す。 */
  const finish = (status) => {
    const files = filesFromMap(currentFiles);
    let outputDir = null;
    try {
      outputDir = writeFileTree(path.join(OUTPUT_DIR, sessionId), files);
    } catch (e) {
      console.warn(`[Warn] 成果物の書き出しに失敗: ${e.message}`);
    }
    if (outputDir) {
      console.log(`[Files] ${files.length}個のファイルを ${outputDir} に書き出しました`);
    }

    let runsDir = null;
    if (SNAPSHOTS && rounds.length) {
      try {
        fs.mkdirSync(runsSessionDir, { recursive: true });
        fs.writeFileSync(
          path.join(runsSessionDir, "SUMMARY.md"),
          buildSummary({
            task,
            sessionId,
            status,
            maxRounds,
            usage: meter.summary(),
            finalPaths: files.map((f) => f.path),
            tests: { status: testStatus, files: [...frozenTests.keys()] },
            rounds,
          }),
          "utf-8"
        );
        runsDir = runsSessionDir;
        console.log(`[Runs] 遷移サマリ: ${path.join(runsDir, "SUMMARY.md")}`);
      } catch (e) {
        console.warn(`[Warn] SUMMARY.md の生成に失敗: ${e.message}`);
      }
    }

    saveLog(sessionId, {
      event: "finish",
      status,
      files: files.map((f) => f.path),
      output_dir: outputDir,
      runs_dir: runsDir,
      tests: { status: testStatus, files: [...frozenTests.keys()] },
      usage: meter.summary(),
    });
    return {
      code,
      files,
      outputDir,
      runsDir,
      status,
      tests: { status: testStatus, files: [...frozenTests.keys()] },
      usage: meter.summary(),
    };
  };

  for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
    console.log(`\n=== Round ${roundNum}/${maxRounds} ===`);

    if (reportBudget(meter)) return finish("budget_exceeded");

    code = await callAgent(DEVELOPER_SYSTEM, devHistory, DEVELOPER_MODEL, meter);
    devHistory.push({ role: "assistant", content: code });

    // 凍結テストがある場合、Developer が test/ 配下や凍結テストを出力しても取り込まない
    const isProtected = frozenTests.size
      ? (p) => p === "test" || p.startsWith("test/") || frozenTests.has(p)
      : undefined;

    const { changed, deleted, ignored } = mergeFiles(currentFiles, code, isProtected);
    if (ignored.length) {
      console.warn(`[Warn] テストは凍結済みです。Developer の出力を無視: ${ignored.join(", ")}`);
    }

    if (SNAPSHOTS && currentFiles.size) {
      try {
        writeFileTree(path.join(runsSessionDir, `round-${roundNum}`), filesFromMap(currentFiles));
      } catch (e) {
        console.warn(`[Warn] スナップショット保存に失敗: ${e.message}`);
      }
    }

    // 回帰ガード: 前回が決定的ゲートの自動REJECT なら「直せ」の意なのでスキップ。
    if (roundNum > 1 && lastReview && !lastRejectWasAuto) {
      const unflagged = changed.filter((p) => !lastReview.includes(p));
      if (unflagged.length) {
        console.warn(`[Warn] レビュー指摘に無いファイルが変更されました: ${unflagged.join(", ")}`);
      }
    }

    if (VERBOSE) {
      console.log(`[Developer]\n${code}\n`);
    } else {
      const delNote = deleted.length ? ` / 削除 ${deleted.join(", ")}` : "";
      console.log(
        `[Developer] 変更 ${changed.length} / 全 ${currentFiles.size} ファイル${delNote}\n` +
          `${summarizeDevOutput(code)}\n`
      );
    }

    if (reportBudget(meter)) return finish("budget_exceeded");

    /** REJECT時、次ラウンドの Developer 入力を積む。 */
    const pushRejectFeedback = (reviewText, opts = {}) => {
      devHistory.push({
        role: "user",
        content:
          `${opts.label || "レビュー結果"}:\n${reviewText}\n\n` +
          `現在のプロジェクト全ファイル:\n${renderFiles(currentFiles)}\n\n` +
          (opts.instruction ||
            `REJECT の根拠になった項目を最優先で修正し、**変更するファイルだけ**出力してください。` +
              `「改善提案（対応任意）」は、コストが小さく明らかに有益なものだけ取り込めば十分です。`),
      });
    };

    /** LLM を呼ばずに REJECT を確定させる（決定的ゲート用）。 */
    const autoReject = (reviewText, logExtra, feedbackOpts) => {
      lastReview = reviewText;
      lastRejectWasAuto = true;
      rounds.push({ round: roundNum, verdict: "REJECT", changed, deleted, review: reviewText });
      saveLog(sessionId, {
        round: roundNum,
        developer_output: code,
        changed_files: changed,
        deleted_files: deleted,
        reviewer_output: reviewText,
        verdict: "REJECT",
        usage: meter.summary(),
        ...logExtra,
      });
      console.log(
        `[Usage] 累計 ${meter.total} トークン（入力 ${meter.totalInput} / 出力 ${meter.totalOutput}）`
      );
      pushRejectFeedback(reviewText, feedbackOpts);
    };

    // --- 決定的チェック（フェーズ1）: 失敗なら Reviewer を呼ばず即 REJECT ---
    if (CHECKS && currentFiles.size) {
      const { ok, problems } = await runChecks(sessionId, roundNum, currentFiles);
      if (!ok) {
        console.log(`[Checks] NG\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
        autoReject(
          "REJECT\n決定的チェック（構文・読み込み）で失敗:\n" + problems.map((p) => `- ${p}`).join("\n"),
          { checks: problems },
          {
            label: "自動チェック結果",
            instruction:
              "まず全ファイルがエラーなく読み込める状態にしてください（構文エラー・" +
              "モジュール解決エラー・ESM/CommonJS の不整合など）。**変更するファイルだけ**出力してください。",
          }
        );
        if (reportBudget(meter)) return finish("budget_exceeded");
        continue;
      }
      console.log(`[Checks] OK`);
    }

    // --- 受け入れテスト（フェーズ3）: node --test ---
    let testEvidence = "";
    if (frozenTests.size && currentFiles.size) {
      const t = await runTests(sessionId, roundNum, currentFiles, frozenTests);
      console.log(`[Tests] ${t.summary}`);
      if (!t.ok && TEST_FAIL_MODE === "reject") {
        autoReject(
          `REJECT\n受け入れテストが失敗（${t.summary}）:\n\n${t.output}`,
          { tests: t.summary, test_output: t.output },
          {
            label: "テスト結果",
            instruction:
              "失敗したテストを通してください。テストファイル（test/ 配下）は変更しません。" +
              "**変更するファイルだけ**出力してください。",
          }
        );
        if (reportBudget(meter)) return finish("budget_exceeded");
        continue;
      }
      testEvidence = t.ok
        ? `\n\n# 受け入れテスト結果\n全通過（${t.summary}）`
        : `\n\n# 受け入れテスト結果（失敗あり）\n${t.summary}\n\`\`\`\n${t.output}\n\`\`\``;
    }

    // Reviewer には累積したプロジェクト全体を見せる（差分だけ見せない）
    const projectView = currentFiles.size ? renderFiles(currentFiles) : code;
    const review = await callAgent(
      REVIEWER_SYSTEM,
      [
        {
          role: "user",
          content: `# 元のタスク（要件）\n${task}\n\n# 現在のプロジェクト全体\n${projectView}${testEvidence}`,
        },
      ],
      REVIEWER_MODEL,
      meter
    );
    console.log(`[Reviewer]\n${review}\n`);
    lastReview = review;
    lastRejectWasAuto = false;

    const verdict = review.trim().startsWith("APPROVE") ? "APPROVE" : "REJECT";
    rounds.push({ round: roundNum, verdict, changed, deleted, review });

    saveLog(sessionId, {
      round: roundNum,
      developer_output: code,
      changed_files: changed,
      deleted_files: deleted,
      reviewer_output: review,
      verdict,
      usage: meter.summary(),
    });
    console.log(
      `[Usage] 累計 ${meter.total} トークン（入力 ${meter.totalInput} / 出力 ${meter.totalOutput}）`
    );

    if (verdict === "APPROVE") {
      console.log(`=== 合格（Round ${roundNum}で承認） ===`);
      return finish("approved");
    }

    if (reportBudget(meter)) return finish("budget_exceeded");

    pushRejectFeedback(review);
  }

  console.log(`=== 最大ラウンド（${maxRounds}）に到達したため停止 ===`);
  return finish("max_rounds_reached");
}
