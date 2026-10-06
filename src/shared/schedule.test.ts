import { describe, expect, it } from "vitest";
import { addDays, diffDays, fromDayNum, isDateStr, toDayNum, todayInTokyo, weekdayOf } from "./date";
import { type CalendarRule, type Schedule, evaluate, isOccurrence, nextOccurrenceAfter, parseCalendarRule } from "./schedule";

// 参考：2026-10-04 は日曜。10月の日曜は 4・11・18・25。
// 11月の日曜は 1・8・15・22・29。12月の日曜は 6・13・20・27（第5日曜は無い）。2027年2月は28日まで。

/** from から to まで（両端を含む）の予定日を並べる */
function occurrences(rule: CalendarRule, from: string, to: string): string[] {
  const out: string[] = [];
  for (let n = toDayNum(from); n <= toDayNum(to); n++) if (isOccurrence(rule, n)) out.push(fromDayNum(n));
  return out;
}

const cal = (rule: CalendarRule): Schedule => ({ type: "calendar", rule });
const interval = (intervalDays: number, firstDueOn: string): Schedule => ({ type: "interval", intervalDays, firstDueOn });

describe("日付", () => {
  it("曜日と日数の計算", () => {
    expect(weekdayOf(toDayNum("2026-10-04"))).toBe(0);
    expect(weekdayOf(toDayNum("2026-10-31"))).toBe(6);
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(diffDays("2026-10-04", "2026-10-11")).toBe(7);
  });

  it("日付の形を確かめる", () => {
    expect(isDateStr("2026-02-29")).toBe(false);
    expect(isDateStr("2028-02-29")).toBe(true);
    expect(isDateStr("2026-13-01")).toBe(false);
    expect(isDateStr("2026-1-01")).toBe(false);
  });

  it("日本時間の今日：UTC 15:00 で日付が変わる", () => {
    expect(todayInTokyo(new Date("2026-10-04T14:59:59Z"))).toBe("2026-10-04");
    expect(todayInTokyo(new Date("2026-10-04T15:00:00Z"))).toBe("2026-10-05");
  });
});

describe("カレンダーの予定日", () => {
  it("毎週日曜", () => {
    const r: CalendarRule = { kind: "weekly", weekdays: [0], every: 1, anchor: "2026-10-01" };
    expect(occurrences(r, "2026-10-01", "2026-10-31")).toEqual(["2026-10-04", "2026-10-11", "2026-10-18", "2026-10-25"]);
  });

  it("毎週 月・木（複数の曜日）", () => {
    const r: CalendarRule = { kind: "weekly", weekdays: [1, 4], every: 1, anchor: "2026-10-01" };
    expect(occurrences(r, "2026-10-01", "2026-10-12")).toEqual(["2026-10-01", "2026-10-05", "2026-10-08", "2026-10-12"]);
  });

  it("隔週の日曜：anchor の週から数える", () => {
    const r: CalendarRule = { kind: "weekly", weekdays: [0], every: 2, anchor: "2026-10-07" };
    // 10/7（水）の週は 10/4〜10/10。その週の日曜 10/4 は anchor より前なので入らない
    expect(occurrences(r, "2026-10-01", "2026-11-15")).toEqual(["2026-10-18", "2026-11-01", "2026-11-15"]);
  });

  it("毎月第1日曜", () => {
    const r: CalendarRule = { kind: "monthly_nth_weekday", nth: 1, weekday: 0, every: 1, anchor: "2026-10-01" };
    expect(occurrences(r, "2026-10-01", "2027-01-31")).toEqual(["2026-10-04", "2026-11-01", "2026-12-06", "2027-01-03"]);
  });

  it("毎月第5日曜：無い月は飛ばす", () => {
    const r: CalendarRule = { kind: "monthly_nth_weekday", nth: 5, weekday: 0, every: 1, anchor: "2026-10-01" };
    expect(occurrences(r, "2026-10-01", "2027-01-31")).toEqual(["2026-11-29", "2027-01-31"]);
  });

  it("毎月最終日曜", () => {
    const r: CalendarRule = { kind: "monthly_nth_weekday", nth: -1, weekday: 0, every: 1, anchor: "2026-10-01" };
    expect(occurrences(r, "2026-10-01", "2026-12-31")).toEqual(["2026-10-25", "2026-11-29", "2026-12-27"]);
  });

  it("3か月ごとの第1日曜", () => {
    const r: CalendarRule = { kind: "monthly_nth_weekday", nth: 1, weekday: 0, every: 3, anchor: "2026-10-01" };
    expect(occurrences(r, "2026-10-01", "2027-04-30")).toEqual(["2026-10-04", "2027-01-03", "2027-04-04"]);
  });

  it("毎月1日", () => {
    const r: CalendarRule = { kind: "monthly_day", day: 1, every: 1, anchor: "2026-10-01" };
    expect(occurrences(r, "2026-10-01", "2026-12-31")).toEqual(["2026-10-01", "2026-11-01", "2026-12-01"]);
  });

  it("毎月31日：無い月は月末に寄せる", () => {
    const r: CalendarRule = { kind: "monthly_day", day: 31, every: 1, anchor: "2026-10-01" };
    expect(occurrences(r, "2026-10-01", "2027-02-28")).toEqual(["2026-10-31", "2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"]);
  });

  it("月末（day=-1）", () => {
    const r: CalendarRule = { kind: "monthly_day", day: -1, every: 1, anchor: "2027-01-15" };
    expect(occurrences(r, "2027-01-01", "2027-03-31")).toEqual(["2027-01-31", "2027-02-28", "2027-03-31"]);
  });

  it("2か月ごとの15日", () => {
    const r: CalendarRule = { kind: "monthly_day", day: 15, every: 2, anchor: "2026-10-20" };
    // 10月は anchor（10/20）より前の 10/15 なので入らない。次は12月
    expect(occurrences(r, "2026-10-01", "2027-03-31")).toEqual(["2026-12-15", "2027-02-15"]);
  });

  it("隔週：anchor を木曜にすると、その週の日曜（過去）が数え始めになるので、最初は2週後", () => {
    const r: CalendarRule = { kind: "weekly", weekdays: [0], every: 2, anchor: "2026-10-01" };
    expect(occurrences(r, "2026-10-01", "2026-10-31")).toEqual(["2026-10-11", "2026-10-25"]);
  });

  it("anchor より前には予定日を作らない", () => {
    const r: CalendarRule = { kind: "weekly", weekdays: [0], every: 1, anchor: "2026-10-07" };
    expect(nextOccurrenceAfter(r, toDayNum("2026-10-01"))).toBe(toDayNum("2026-10-11"));
  });
});

describe("前回からの日数（interval）", () => {
  const s = interval(7, "2026-10-10");

  it("記録が無ければ、登録で指定した最初の期限", () => {
    expect(evaluate(s, [], "2026-10-05")).toMatchObject({ dueOn: "2026-10-10", status: "upcoming", daysLate: 0 });
    expect(evaluate(s, [], "2026-10-10")).toMatchObject({ dueOn: "2026-10-10", status: "today", daysLate: 0 });
    expect(evaluate(s, [], "2026-10-13")).toMatchObject({ dueOn: "2026-10-10", status: "overdue", daysLate: 3 });
  });

  it("次の期限は最後にやった日＋N日。遅れたらその分ずれる", () => {
    const e = evaluate(s, ["2026-10-13"], "2026-10-14");
    expect(e).toMatchObject({ dueOn: "2026-10-20", status: "upcoming" });
    expect(e.cycles).toEqual([{ dueOn: "2026-10-10", doneOn: "2026-10-13", daysLate: 3, missed: false }]);
  });

  it("早めにやれば、そこから数える", () => {
    expect(evaluate(s, ["2026-10-08"], "2026-10-08")).toMatchObject({ dueOn: "2026-10-15", status: "upcoming" });
  });

  it("さかのぼった記録も順番どおりに数える（記録の順は問わない）", () => {
    const e = evaluate(s, ["2026-10-24", "2026-10-10"], "2026-10-25");
    expect(e.dueOn).toBe("2026-10-31");
    expect(e.cycles.map((c) => [c.dueOn, c.doneOn, c.daysLate])).toEqual([
      ["2026-10-10", "2026-10-10", 0],
      ["2026-10-17", "2026-10-24", 7],
    ]);
  });

  it("取り消し（記録が減る）で前の期限に戻る", () => {
    expect(evaluate(s, [], "2026-10-14")).toMatchObject({ dueOn: "2026-10-10", status: "overdue", daysLate: 4 });
  });

  it("今日より後の記録は無視する", () => {
    expect(evaluate(s, ["2026-10-20"], "2026-10-12")).toMatchObject({ dueOn: "2026-10-10", status: "overdue", daysLate: 2 });
  });
});

describe("カレンダーで固定（calendar）", () => {
  const sunday = cal({ kind: "weekly", weekdays: [0], every: 1, anchor: "2026-10-01" });

  it("最初の予定日まではまだ先", () => {
    expect(evaluate(sunday, [], "2026-10-02")).toMatchObject({ dueOn: "2026-10-04", status: "upcoming", cycles: [] });
  });

  it("予定日の当日", () => {
    expect(evaluate(sunday, [], "2026-10-04")).toMatchObject({ dueOn: "2026-10-04", status: "today" });
  });

  it("予定日を過ぎてやっていなければ、遅れ日数を出す", () => {
    expect(evaluate(sunday, [], "2026-10-07")).toMatchObject({ dueOn: "2026-10-04", status: "overdue", daysLate: 3 });
  });

  it("次の予定日が来たら前の回は打ち切り、遅れは数え直す", () => {
    const e = evaluate(sunday, [], "2026-10-12");
    expect(e).toMatchObject({ dueOn: "2026-10-11", status: "overdue", daysLate: 1 });
    expect(e.cycles).toEqual([{ dueOn: "2026-10-04", doneOn: null, daysLate: null, missed: true }]);
  });

  it("遅れてやったら、その回は済み（遅れ日数つき）。次の期限は次の予定日", () => {
    const e = evaluate(sunday, ["2026-10-06"], "2026-10-07");
    expect(e).toMatchObject({ dueOn: "2026-10-11", status: "upcoming" });
    expect(e.cycles).toEqual([{ dueOn: "2026-10-04", doneOn: "2026-10-06", daysLate: 2, missed: false }]);
  });

  it("前倒し：済んでいる回のあとにやったら、次の予定日の分になる", () => {
    // 10/4 の回を当日に済ませ、10/10（土）にもやった → 10/11 の分を前倒しで済ませた
    const e = evaluate(sunday, ["2026-10-04", "2026-10-10"], "2026-10-10");
    expect(e).toMatchObject({ dueOn: "2026-10-18", status: "upcoming" });
    expect(e.cycles.map((c) => [c.dueOn, c.doneOn, c.daysLate])).toEqual([
      ["2026-10-04", "2026-10-04", 0],
      ["2026-10-11", "2026-10-10", 0],
    ]);
  });

  it("前倒しした予定日の当日も、済んだまま", () => {
    const e = evaluate(sunday, ["2026-10-04", "2026-10-10"], "2026-10-11");
    expect(e).toMatchObject({ dueOn: "2026-10-18", status: "upcoming" });
  });

  it("前倒しは次の1回分だけ", () => {
    const e = evaluate(sunday, ["2026-10-04", "2026-10-09", "2026-10-10"], "2026-10-10");
    expect(e.dueOn).toBe("2026-10-18");
    expect(e.cycles).toHaveLength(2);
  });

  it("最初の予定日より前にやったら、最初の回の前倒し", () => {
    const e = evaluate(sunday, ["2026-10-02"], "2026-10-03");
    expect(e).toMatchObject({ dueOn: "2026-10-11", status: "upcoming" });
    expect(e.cycles).toEqual([{ dueOn: "2026-10-04", doneOn: "2026-10-02", daysLate: 0, missed: false }]);
  });

  it("何週も放っておくと、打ち切りが並び、いまの回だけが開いている", () => {
    const e = evaluate(sunday, [], "2026-10-26");
    expect(e).toMatchObject({ dueOn: "2026-10-25", status: "overdue", daysLate: 1 });
    expect(e.cycles.filter((c) => c.missed).map((c) => c.dueOn)).toEqual(["2026-10-04", "2026-10-11", "2026-10-18"]);
  });

  it("毎月第1日曜：遅れても次の月の予定日で打ち切り", () => {
    const s = cal({ kind: "monthly_nth_weekday", nth: 1, weekday: 0, every: 1, anchor: "2026-10-01" });
    expect(evaluate(s, [], "2026-10-20")).toMatchObject({ dueOn: "2026-10-04", status: "overdue", daysLate: 16 });
    expect(evaluate(s, [], "2026-11-02")).toMatchObject({ dueOn: "2026-11-01", status: "overdue", daysLate: 1 });
    expect(evaluate(s, ["2026-10-20"], "2026-10-21")).toMatchObject({ dueOn: "2026-11-01", status: "upcoming" });
  });

  it("毎月31日：短い月は月末が期限", () => {
    const s = cal({ kind: "monthly_day", day: 31, every: 1, anchor: "2026-11-01" });
    expect(evaluate(s, [], "2026-11-15")).toMatchObject({ dueOn: "2026-11-30", status: "upcoming" });
  });

  it("隔週：予定日の無い週の記録は、前の回の遅れとして入る", () => {
    // 隔週・nか月ごとは、登録で選んだ最初の予定日を anchor にする
    const s = cal({ kind: "weekly", weekdays: [0], every: 2, anchor: "2026-10-04" });
    // 予定日は 10/4, 10/18, … 10/11 にやると 10/4 の回が7日遅れで済む
    const e = evaluate(s, ["2026-10-11"], "2026-10-12");
    expect(e).toMatchObject({ dueOn: "2026-10-18", status: "upcoming" });
    expect(e.cycles[0]).toMatchObject({ dueOn: "2026-10-04", daysLate: 7 });
  });

  it("毎週 月・木：曜日ごとに1回", () => {
    const s = cal({ kind: "weekly", weekdays: [1, 4], every: 1, anchor: "2026-10-01" });
    // 10/1(木) 10/5(月) 10/8(木)。10/5 をやらずに 10/7 → 10/5 の回が2日遅れ
    expect(evaluate(s, ["2026-10-01"], "2026-10-07")).toMatchObject({ dueOn: "2026-10-05", status: "overdue", daysLate: 2 });
  });
});

describe("parseCalendarRule", () => {
  it("正しい規則を通し、曜日を並べ直す", () => {
    expect(parseCalendarRule({ kind: "weekly", weekdays: [4, 1, 1], anchor: "2026-10-01" })).toEqual({
      kind: "weekly",
      weekdays: [1, 4],
      every: 1,
      anchor: "2026-10-01",
    });
  });

  it("おかしな規則は断る", () => {
    expect(() => parseCalendarRule({ kind: "weekly", weekdays: [], anchor: "2026-10-01" })).toThrow();
    expect(() => parseCalendarRule({ kind: "weekly", weekdays: [7], anchor: "2026-10-01" })).toThrow();
    expect(() => parseCalendarRule({ kind: "monthly_nth_weekday", nth: 6, weekday: 0, anchor: "2026-10-01" })).toThrow();
    expect(() => parseCalendarRule({ kind: "monthly_day", day: 0, anchor: "2026-10-01" })).toThrow();
    expect(() => parseCalendarRule({ kind: "monthly_day", day: 1, every: 0, anchor: "2026-10-01" })).toThrow();
    expect(() => parseCalendarRule({ kind: "monthly_day", day: 1, anchor: "2026/10/01" })).toThrow();
    expect(() => parseCalendarRule({ kind: "yearly" })).toThrow();
  });
});
