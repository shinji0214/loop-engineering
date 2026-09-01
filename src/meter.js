export const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** トークン消費量の計測・レート制限・予算チェックをまとめて担う。 */
export class TokenMeter {
  /** @param {{budget: number, ratePerMinute: number}} opts */
  constructor({ budget, ratePerMinute }) {
    this.budget = budget;
    this.ratePerMinute = ratePerMinute;
    this.totalInput = 0;
    this.totalOutput = 0;
    /** @type {{t: number, tokens: number}[]} 直近の消費イベント（レート制限用） */
    this.events = [];
  }

  get total() {
    return this.totalInput + this.totalOutput;
  }

  /** 直近60秒の消費量がレート上限を超えている間だけ待機する。 */
  async throttle() {
    if (!this.ratePerMinute) return;
    for (;;) {
      const now = Date.now();
      this.events = this.events.filter((e) => now - e.t < 60_000);
      const used = this.events.reduce((s, e) => s + e.tokens, 0);
      if (used < this.ratePerMinute || this.events.length === 0) return;
      const waitMs = 60_000 - (now - this.events[0].t);
      console.log(
        `[RateLimit] 直近60秒で ${used} トークン消費（上限 ${this.ratePerMinute}/分）。` +
          `${Math.ceil(waitMs / 1000)} 秒待機します`
      );
      await sleep(waitMs);
    }
  }

  /** 1回の応答の usage を消費量に加算する。 */
  record(usage) {
    const input = usage?.input_tokens ?? 0;
    const output = usage?.output_tokens ?? 0;
    this.totalInput += input;
    this.totalOutput += output;
    this.events.push({ t: Date.now(), tokens: input + output });
  }

  /** 予算超過なら理由文字列、問題なければ null を返す。 */
  budgetExceededReason() {
    if (this.budget && this.total >= this.budget) {
      return (
        `トークン予算 ${this.budget} に到達（消費 ${this.total} = ` +
        `入力 ${this.totalInput} + 出力 ${this.totalOutput}）`
      );
    }
    return null;
  }

  summary() {
    return { input: this.totalInput, output: this.totalOutput, total: this.total };
  }
}
