import { describe, expect, it } from "vitest";
import { describeRule } from "./describe";
import type { CalendarRule } from "./schedule";

const A = "2026-10-01";

describe("周期の説明", () => {
  it.each<[CalendarRule, string]>([
    [{ kind: "weekly", weekdays: [1, 4], every: 1, anchor: A }, "毎週 月・木曜"],
    [{ kind: "weekly", weekdays: [6], every: 2, anchor: A }, "隔週 土曜"],
    [{ kind: "weekly", weekdays: [0, 3], every: 1, anchor: A }, "毎週 水・日曜"],
    [{ kind: "monthly_nth_weekday", nths: [1, 3], weekdays: [0, 6], every: 1, anchor: A }, "毎月 第1・第3 土・日曜"],
    [{ kind: "monthly_nth_weekday", nths: [-1], weekdays: [5], every: 1, anchor: A }, "毎月 最終金曜"],
    [{ kind: "monthly_nth_weekday", nths: [1], weekdays: [0], every: 3, anchor: A }, "3か月ごと 第1日曜"],
    [{ kind: "monthly_nth_weekday", nths: [1], weekdays: [6], every: 1, anchor: A, months: [1, 4, 7, 10] }, "1・4・7・10月 第1土曜"],
    [{ kind: "monthly_nth_weekday", nths: [2, -1], weekdays: [3], every: 1, anchor: A }, "毎月 第2・最終 水曜"],
    [{ kind: "monthly_nth_weekday", nths: [2], weekdays: [1, 5], every: 1, anchor: A }, "毎月 第2 月・金曜"],
    [{ kind: "monthly_day", day: -1, every: 1, anchor: A, months: [6, 12] }, "6・12月 末日"],
    [{ kind: "monthly_day", day: 15, every: 1, anchor: A }, "毎月 15日"],
  ])("%j → %s", (rule, text) => {
    expect(describeRule(rule)).toBe(text);
  });
});
