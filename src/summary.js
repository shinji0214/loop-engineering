import { PROVIDER, DEVELOPER_MODEL, REVIEWER_MODEL } from "./config.js";
import { modelAlias } from "./providers.js";

/**
 * 遷移サマリ Markdown を組み立てる。
 * @param {{
 *   task: string, sessionId: string, status: string, maxRounds: number,
 *   usage: {input:number,output:number,total:number},
 *   finalPaths: string[],
 *   tests?: {status:string, files:string[]},
 *   rounds: {round:number, verdict:string, changed:string[], deleted:string[], review:string}[],
 * }} d
 */
export function buildSummary(d) {
  const L = [];
  L.push(`# 実行サマリ — ${d.sessionId}`, "");
  L.push(`- タスク: ${d.task}`);
  L.push(
    `- provider: ${PROVIDER} / models: ${modelAlias(DEVELOPER_MODEL)} (dev) / ${modelAlias(REVIEWER_MODEL)} (review)`
  );
  L.push(`- 最終ステータス: **${d.status}**`);
  L.push(`- ラウンド: ${d.rounds.length} / ${d.maxRounds}`);
  L.push(`- 消費トークン: ${d.usage.total}（入力 ${d.usage.input} / 出力 ${d.usage.output}）`);
  L.push(`- 最終ファイル: ${d.finalPaths.join(", ") || "(なし)"}`);
  if (d.tests && d.tests.status !== "off") {
    L.push(`- 受け入れテスト: ${d.tests.status}（${d.tests.files.join(", ") || "なし"}）`);
  }
  L.push("");
  L.push("## 遷移", "");
  L.push("| R | 判定 | 変更 | 削除 | 前ラウンド指摘への対応 |");
  L.push("|---|---|---|---|---|");
  d.rounds.forEach((r, i) => {
    const prev = d.rounds[i - 1];
    let followUp = "—";
    if (prev && prev.verdict === "REJECT") {
      if (r.verdict === "APPROVE") {
        followUp = "✅ 承認";
      } else {
        const touched = r.changed.filter((p) => prev.review.includes(p));
        followUp = touched.length ? `🔧 ${touched.join(" ")} を再修正` : "🔁 再REJECT";
      }
    }
    L.push(
      `| ${r.round} | ${r.verdict} | ${r.changed.join(" ") || "—"} | ${
        r.deleted.join(" ") || "—"
      } | ${followUp} |`
    );
  });
  L.push("");
  if (d.rounds.length >= 2) {
    L.push(
      "ラウンド間の差分:",
      "```",
      `diff -r runs/${d.sessionId}/round-1 runs/${d.sessionId}/round-2`,
      "```",
      ""
    );
  }
  L.push("## ラウンド詳細");
  for (const r of d.rounds) {
    L.push("", `### Round ${r.round} — ${r.verdict}`, "");
    const chg = r.changed.join(", ") || "—";
    const del = r.deleted.length ? ` / 削除: ${r.deleted.join(", ")}` : "";
    L.push(`変更ファイル: ${chg}${del}`, "", "Reviewer:", "", "```", r.review.trim(), "```");
  }
  return L.join("\n") + "\n";
}
