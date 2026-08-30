/**
 * オセロ実装の受け入れテスト（現状確認用の実験スクリプト）
 *
 * ループが APPROVE した成果物を「実際に動かして」検証し、
 * 「ループの判定」と「実挙動」のズレを見るためのもの。
 *
 * 使い方:
 *   node experiments/othello-check.mjs output/<セッションID>
 *
 * 前提の仕様（index.js に渡すプロンプトで固定しておくこと）:
 *   - board = 8x8 の2次元配列。0=空 / 1=黒 / 2=白。board[行][列]、行0が上。
 *   - initialBoard(): 黒=[3,4],[4,3] 白=[3,3],[4,4] 他0。呼ぶたび新しい配列。
 *   - legalMoves(board, player): player(1|2) の合法手を [行,列] の配列で（順不同）。
 *   - applyMove(board, player, pos): 着手＋8方向の石返しをした新しい盤面。非破壊。合法手でなければ throw。
 *   - winner(board): 黒多→1 / 白多→2 / 同数→0。
 *   - src/othello.js に実装、src/index.js で再export。
 */

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2];
if (!dir) {
  console.error("使い方: node experiments/othello-check.mjs output/<セッションID>");
  process.exit(2);
}

const entry = pathToFileURL(path.resolve(dir, "src/index.js")).href;
let mod;
try {
  mod = await import(entry);
} catch (e) {
  console.error(`src/index.js を import できません: ${e.message}`);
  process.exit(2);
}

const { initialBoard, legalMoves, applyMove, winner } = mod;
for (const [k, v] of Object.entries({ initialBoard, legalMoves, applyMove, winner })) {
  if (typeof v !== "function") {
    console.error(`関数がエクスポートされていない: ${k}（仕様どおり再export されていない）`);
    process.exit(2);
  }
}

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  NG   ${name}\n         ${e.message || e}`);
  }
};

const countAll = (b) => b.flat().reduce((a, v) => ((a[v] = (a[v] || 0) + 1), a), {});
const sortPos = (a) => [...a].map((p) => `${p[0]},${p[1]}`).sort();
const empty = () => Array.from({ length: 8 }, () => Array(8).fill(0));

// --- initialBoard -------------------------------------------------------
t("initialBoard: 8x8", () => {
  const b = initialBoard();
  assert.equal(b.length, 8);
  assert.ok(b.every((r) => r.length === 8));
});
t("initialBoard: 初期4石の配置（黒[3,4][4,3] 白[3,3][4,4]）", () => {
  const b = initialBoard();
  assert.equal(b[3][3], 2, "[3,3]は白のはず");
  assert.equal(b[4][4], 2, "[4,4]は白のはず");
  assert.equal(b[3][4], 1, "[3,4]は黒のはず");
  assert.equal(b[4][3], 1, "[4,3]は黒のはず");
  const c = countAll(b);
  assert.equal(c[1], 2);
  assert.equal(c[2], 2);
  assert.equal(c[0], 60);
});
t("initialBoard: 呼ぶたび新しい配列", () => {
  const b1 = initialBoard();
  b1[0][0] = 9;
  assert.equal(initialBoard()[0][0], 0);
});

// --- legalMoves --------------------------------------------------------
t("legalMoves: 黒の初手はちょうど4手（[2,3][3,2][4,5][5,4]）", () => {
  const m = legalMoves(initialBoard(), 1);
  assert.deepEqual(sortPos(m), sortPos([[2, 3], [3, 2], [4, 5], [5, 4]]));
});
t("legalMoves: board を変更しない", () => {
  const b = initialBoard();
  const snap = JSON.stringify(b);
  legalMoves(b, 1);
  assert.equal(JSON.stringify(b), snap);
});
t("legalMoves: 打てない局面は空配列（パス相当）", () => {
  const b = empty();
  b[0][0] = 1; // 黒1個だけ → 白は打てない
  assert.deepEqual(legalMoves(b, 2), []);
});

// --- applyMove --------------------------------------------------------
t("applyMove: 黒[2,3] で [3,3] が裏返る", () => {
  const nb = applyMove(initialBoard(), 1, [2, 3]);
  assert.equal(nb[2][3], 1, "着手位置が黒になっていない");
  assert.equal(nb[3][3], 1, "[3,3]（元・白）が裏返っていない");
  const c = countAll(nb);
  assert.equal(c[1], 4);
  assert.equal(c[2], 1);
});
t("applyMove: 非破壊（渡した board が変わらない）", () => {
  const b = initialBoard();
  const snap = JSON.stringify(b);
  applyMove(b, 1, [2, 3]);
  assert.equal(JSON.stringify(b), snap);
});
t("applyMove: 合法手でなければ throw", () => {
  assert.throws(() => applyMove(initialBoard(), 1, [0, 0]));
});
t("applyMove: 8方向すべてで石返しが起きる", () => {
  const b = empty();
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      b[4 + dr][4 + dc] = 2; // 隣は白
      b[4 + dr * 2][4 + dc * 2] = 1; // その先は黒
    }
  }
  const nb = applyMove(b, 1, [4, 4]);
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      assert.equal(nb[4 + dr][4 + dc], 1, `方向(${dr},${dc})が裏返っていない`);
    }
  }
});

// --- winner ----------------------------------------------------------
t("winner: 石数で勝敗（黒多→1 / 同数→0）", () => {
  const b = empty();
  b[0][0] = 1;
  b[0][1] = 1;
  b[0][2] = 2;
  assert.equal(winner(b), 1);
  b[0][3] = 2;
  assert.equal(winner(b), 0);
});

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
