// 周期や日付を、画面に出す日本語にする（画面とサーバの両方で使う）
import { type DateStr, toDayNum, weekdayOf } from "./date";
import type { CalendarRule, Schedule } from "./schedule";

export const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

const nthText = (nth: number) => (nth === -1 ? "最終" : `第${nth}`);

/** 曜日を月曜から並べて「月・木」「土・日」にする（日曜は最後） */
const weekdaysText = (days: number[]) =>
  [...days]
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map((d) => WEEKDAYS[d])
    .join("・");

function everyWeeks(n: number) {
  return n === 1 ? "毎週" : n === 2 ? "隔週" : `${n}週ごと`;
}
/** 「毎月」「3か月ごと」「1・4・7・10月」 */
function monthsText(r: { every: number; months?: number[] }) {
  if (r.months) return `${r.months.join("・")}月`;
  return r.every === 1 ? "毎月" : `${r.every}か月ごと`;
}

/** 「第1日曜」「第1・第3 土・日曜」 */
function nthWeekdaysText(nths: number[], weekdays: number[]) {
  const sep = nths.length === 1 && weekdays.length === 1 ? "" : " ";
  return `${nths.map(nthText).join("・")}${sep}${weekdaysText(weekdays)}曜`;
}

export function describeRule(r: CalendarRule): string {
  switch (r.kind) {
    case "weekly":
      return `${everyWeeks(r.every)} ${weekdaysText(r.weekdays)}曜`;
    case "monthly_nth_weekday":
      return `${monthsText(r)} ${nthWeekdaysText(r.nths, r.weekdays)}`;
    case "monthly_day":
      return `${monthsText(r)} ${r.day === -1 ? "末日" : `${r.day}日`}`;
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
