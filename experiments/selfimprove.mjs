/**
 * 再帰的自己改修ドライバ（STEP 4+ の実験）
 *
 *   node experiments/selfimprove.mjs [--generations N]
 *
 * 1世代:
 *   1. experiments/BACKLOG.md の先頭の未完（- [ ]）項目を1つ取る
 *   2. その世代の index.js（gens/gen-<N>/）に FROM_DIR で渡し、TESTS=1 で改修させる
 *   3. 成果物 + Test Writer が作った受け入れテストを gens/gen-<N+1>/ に組み立て、
 *      テストを test/generations/gen-<NNN>/ に昇格（import パスを書き換え）
 *   4. gens/gen-<N+1>/ で凍結オラクル（test/run.mjs）を実行
 *        全通過 → 採用、BACKLOG 項目を - [x] に、次世代へ
 *        失敗   → gens/gen-<N+1>/ を破棄、ログに残して停止
 *
 * gens/ は .gitignore 済み（実験の作業データ）。採用世代を本体に反映するかは人間が判断する。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GENS = path.join(REPO, "gens");
const BACKLOG = path.join(REPO, "experiments", "BACKLOG.md");
const LOG = path.join(GENS, "LOG.md");

// 世代スナップショットに含めるトップレベル項目（生成物・足場は除外）
const SNAPSHOT_INCLUDE = [
  "index.js", "AGENTS.md", "README.md", "STEPS.md",
  "package.json", "package-lock.json", "test",
];

const args = process.argv.slice(2);
const maxGens = Number((args.find((a) => a.startsWith("--generations=")) || "").split("=")[1] || 1);

// --- ユーティリティ -------------------------------------------------------

function sh(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, { encoding: "utf8", timeout: 900_000, ...opts });
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

function genDir(n) {
  return path.join(GENS, `gen-${String(n).padStart(3, "0")}`);
}

function latestGen() {
  if (!fs.existsSync(GENS)) return -1;
  const ns = fs
    .readdirSync(GENS)
    .map((d) => /^gen-(\d+)$/.exec(d))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return ns.length ? Math.max(...ns) : -1;
}

function ensureBase() {
  if (latestGen() >= 0) return;
  const dst = genDir(0);
  fs.mkdirSync(dst, { recursive: true });
  for (const item of SNAPSHOT_INCLUDE) {
    const s = path.join(REPO, item);
    if (!fs.existsSync(s)) continue;
    const d = path.join(dst, item);
    if (fs.statSync(s).isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
  console.log(`[gen-000] 現在の本体を ${path.relative(REPO, dst)} にスナップショット`);
}

function nextBacklogItem() {
  const lines = fs.readFileSync(BACKLOG, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^- \[ \] (.+)$/.exec(lines[i]);
    if (m) return { lineIdx: i, text: m[1].trim() };
  }
  return null;
}

function markBacklogDone(lineIdx) {
  const lines = fs.readFileSync(BACKLOG, "utf8").split("\n");
  lines[lineIdx] = lines[lineIdx].replace("- [ ] ", "- [x] ");
  fs.writeFileSync(BACKLOG, lines.join("\n"), "utf8");
}

function appendLog(md) {
  fs.mkdirSync(GENS, { recursive: true });
  fs.appendFileSync(LOG, md + "\n", "utf8");
}

const TASK_GUIDANCE = `

---
【自己改修タスクの指示】
- これはこのループ本体（プロジェクトルートの index.js）の改修。FROM_DIR で現在の全ソースが渡されている。
- 変更してよいのは index.js だけ。test/ 配下は凍結・変更禁止。
- 受け入れテストは test/acceptance.test.js に置くこと。
- 検証対象の関数が index.js から export されていなければ export を付け、
  \`import { <関数名> } from '../index.js'\` の形で import してテストする。
- 既存の \`node test/run.mjs\` が通る状態を保つこと。`;

// --- 1世代 --------------------------------------------------------------

function runGeneration(n) {
  const base = genDir(n);
  const item = nextBacklogItem();
  if (!item) {
    console.log("BACKLOG に未完項目なし。終了。");
    return "done";
  }
  console.log(`\n========== gen-${n} → gen-${n + 1} ==========`);
  console.log(`改善: ${item.text}\n`);

  const artifactRoot = fs.mkdtempSync(path.join(GENS, `run-${n}-`));
  const env = {
    ...process.env,
    FROM_DIR: base,
    TESTS: "1",
    LOOP_ARTIFACT_ROOT: artifactRoot,
    MAX_ROUNDS: process.env.MAX_ROUNDS || "5",
  };

  const r = sh(process.execPath, [path.join(base, "index.js"), item.text + TASK_GUIDANCE], {
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) {
    appendLog(`## gen-${n + 1}: 失敗（ループがエラー終了 code ${r.status}）\n- ${item.text}\n`);
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    return "stop";
  }

  // 成果物・凍結テストの場所を特定
  const outRoot = path.join(artifactRoot, "output");
  const runsRoot = path.join(artifactRoot, "runs");
  const sess = fs.existsSync(outRoot) ? fs.readdirSync(outRoot)[0] : null;
  if (!sess) {
    appendLog(`## gen-${n + 1}: 失敗（成果物なし。承認されなかった可能性）\n- ${item.text}\n`);
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    return "stop";
  }
  const outDir = path.join(outRoot, sess);
  const testsDir = path.join(runsRoot, sess, "tests");

  // gen-<N+1> を組み立て
  const cand = genDir(n + 1);
  fs.rmSync(cand, { recursive: true, force: true });
  copyTree(outDir, cand);

  // Test Writer の受け入れテストを test/generations/gen-<NNN>/ に昇格
  const promotedDir = path.join(cand, "test", "generations", `gen-${String(n + 1).padStart(3, "0")}`);
  let promoted = 0;
  if (fs.existsSync(testsDir)) {
    fs.mkdirSync(promotedDir, { recursive: true });
    for (const f of fs.readdirSync(testsDir)) {
      let content = fs.readFileSync(path.join(testsDir, f), "utf8");
      if (/\.test\.[cm]?js$/.test(f)) {
        // test/acceptance.test.js（root/test 直下想定）→ test/generations/gen-NNN/ に移動するので3段深くなる
        content = content.replace(/(['"])\.\.\/index\.js\1/g, "$1../../../index.js$1");
        promoted++;
      }
      fs.writeFileSync(path.join(promotedDir, f), content, "utf8");
    }
  }

  // 凍結オラクルで検証
  console.log(`\n[gen-${n + 1}] 凍結オラクルを実行...`);
  const oracle = sh(process.execPath, [path.join(cand, "test", "run.mjs")], {
    env: { ...process.env },
    stdio: ["ignore", "inherit", "inherit"],
  });

  if (oracle.status !== 0) {
    appendLog(
      `## gen-${n + 1}: 破棄（凍結オラクル不通過）\n- 改善: ${item.text}\n- 昇格テスト: ${promoted}件\n- 保管: ${path.relative(REPO, cand)}（要調査）\n`
    );
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    console.log(`\n>>> gen-${n + 1} は凍結オラクルに落ちた。停止。`);
    return "stop";
  }

  markBacklogDone(item.lineIdx);
  appendLog(
    `## gen-${n + 1}: 採用 ✅\n- 改善: ${item.text}\n- 昇格テスト: ${promoted}件（test/generations/gen-${String(n + 1).padStart(3, "0")}/）\n- ${path.relative(REPO, cand)}\n`
  );
  fs.rmSync(artifactRoot, { recursive: true, force: true });
  console.log(`\n>>> gen-${n + 1} 採用。`);
  return "next";
}

// --- メイン -----------------------------------------------------------

ensureBase();
let cur = latestGen();
for (let g = 0; g < maxGens; g++) {
  const res = runGeneration(cur);
  if (res !== "next") break;
  cur = latestGen();
}
console.log(`\n最新世代: gen-${latestGen()}  （ログ: ${path.relative(REPO, LOG)}）`);
