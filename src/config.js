/**
 * 環境変数から読む設定値。すべてモジュール読み込み時に1回だけ評価される。
 * （テスト・世代実験は process.env をセットしてから import すること）
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export function numFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEVELOPER_MODEL = process.env.DEVELOPER_MODEL || "claude-sonnet-5";
export const REVIEWER_MODEL = process.env.REVIEWER_MODEL || "claude-sonnet-5";
export const MAX_ROUNDS = numFromEnv("MAX_ROUNDS", 5);

// sdk（Claude Agent SDK）/ cli（`claude` サブプロセス）/ api（Anthropic API 直叩き）
export const PROVIDER = (process.env.LOOP_PROVIDER || "sdk").toLowerCase();

// --- トークン安全弁 ---
export const MAX_OUTPUT_TOKENS = numFromEnv("MAX_OUTPUT_TOKENS", 8000); // api モードのみ強制
export const TOKEN_BUDGET = numFromEnv("TOKEN_BUDGET", 100_000); // 合計消費上限→自動停止
export const TOKENS_PER_MINUTE = numFromEnv("TOKENS_PER_MINUTE", 40_000); // 消費レート上限（0で無効）
export const MAX_BUDGET_USD = numFromEnv("MAX_BUDGET_USD", 0); // sdk のみ、1呼び出しのコスト上限
export const SDK_MAX_TURNS = numFromEnv("SDK_MAX_TURNS", 12); // sdk の1呼び出しの最大ターン

export const VERBOSE = /^(1|true|yes|on)$/i.test(process.env.VERBOSE || "");
export const SNAPSHOTS = !/^(0|false|no|off)$/i.test(process.env.SNAPSHOTS ?? "");

// STEP 4 フェーズ1: 決定的チェック
export const CHECKS = !/^(0|false|no|off)$/i.test(process.env.CHECKS ?? "");
export const CHECK_TIMEOUT_MS = numFromEnv("CHECK_TIMEOUT_MS", 15_000);

// STEP 4 フェーズ2-3: 受け入れテスト（既定 OFF、TESTS=1 で有効）
export const TESTS = /^(1|true|yes|on)$/i.test(process.env.TESTS || "");
export const TEST_MAX_ROUNDS = numFromEnv("TEST_MAX_ROUNDS", 2);
export const TEST_TIMEOUT_MS = numFromEnv("TEST_TIMEOUT_MS", 30_000);
export const TEST_FAIL_MODE = (process.env.TEST_FAIL_MODE || "reject").toLowerCase();
export const TEST_WRITER_MODEL = process.env.TEST_WRITER_MODEL || "claude-sonnet-5";
export const TEST_REVIEWER_MODEL = process.env.TEST_REVIEWER_MODEL || "claude-sonnet-5";

// FROM_DIR=<path>: 既存ファイルツリーを currentFiles の初期値にする（改修・自己編集用）
export const FROM_DIR = process.env.FROM_DIR || "";
export const FROM_DIR_EXCLUDE = new Set([
  "node_modules", ".git", "output", "runs", "logs", ".loop-tmp", "experiments", "gens",
]);

// LOOP_ARTIFACT_ROOT: 生成物（logs/output/runs/.loop-tmp）の出力先を隔離する
const ARTIFACT_ROOT = process.env.LOOP_ARTIFACT_ROOT
  ? path.resolve(process.env.LOOP_ARTIFACT_ROOT)
  : PROJECT_ROOT;
export const LOG_DIR = path.join(ARTIFACT_ROOT, "logs");
export const TMP_DIR = path.join(ARTIFACT_ROOT, ".loop-tmp");
export const OUTPUT_DIR = path.join(ARTIFACT_ROOT, "output");
export const RUNS_DIR = path.join(ARTIFACT_ROOT, "runs");
