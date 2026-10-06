// 周期や日付を、画面に出す日本語にする（画面とサーバの両方で使う）
import { type DateStr, toDayNum, weekdayOf } from "./date";
import type { CalendarRule, Schedule } from "./schedule";

export const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

const nthText = (nth: number) => (nth === -1 ? "最終" : `第${nth}`);

function everyWeeks(n: number) {
  return n === 1 ? "毎週" : n === 2 ? "隔週" : `${n}週ごと`;
}
function everyMonths(n: number) {
  return n === 1 ? "毎月" : `${n}か月ごと`;
}

export function describeRule(r: CalendarRule): string {
  switch (r.kind) {
    case "weekly":
      return `${everyWeeks(r.every)} ${r.weekdays.map((d) => WEEKDAYS[d]).join("・")}曜`;
    case "monthly_nth_weekday":
      return `${everyMonths(r.every)} ${nthText(r.nth)}${WEEKDAYS[r.weekday]}曜`;
    case "monthly_day":
      return `${everyMonths(r.every)} ${r.day === -1 ? "末日" : `${r.day}日`}`;
  }
}

export function describeSchedule(s: Schedule): string {
  return s.type === "interval" ? `${s.intervalDays}日ごと` : describeRule(s.rule);
}

/** "2026-10-12" → "10/12（月）" */
export function shortDate(d: DateStr): string {
  const [, m, day] = d.split("-").map(Number);
  return `${m}/${day}（${WEEKDAYS[weekdayOf(toDayNum(d))]}）`;
}
