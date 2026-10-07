import { describe, expect, it } from "vitest";
import type { Schedule } from "./schedule";
import { type StatsChore, type StatsInput, type StatsLog, computeStats, monthRange } from "./stats";

// 参考：2026-10-01 は木曜、2026-10-04 は日曜。今日は 2026-10-20（火）とする。
const today = "2026-10-20";
const interval = (intervalDays: number, firstDueOn: string): Schedule => ({ type: "interval", intervalDays, firstDueOn });
const sundays: Schedule = { type: "calendar", rule: { kind: "weekly", weekdays: [0], every: 1, anchor: "2026-10-04" } };

const chores: StatsChore[] = [
  // 3日ごと。期限 10-01・10-04・10-08・10-11 の4回（遅れ 0・1・0・3）。10-17 の回は開いている
  { id: "x", name: "風呂掃除", schedule: interval(3, "2026-10-01"), archivedOn: null },
  // 毎週日曜。10-04 は期限内、10-11 はやらずに過ぎた、10-18 は 1日遅れ
  { id: "y", name: "シーツ交換", schedule: sundays, archivedOn: null },
  // 7日ごと。期限 09-20 の回（5日遅れ）は期間の外、10-02 の回は 2日遅れ。10-10 にしまった
  { id: "z", name: "植木の水やり", schedule: interval(7, "2026-09-20"), archivedOn: "2026-10-10" },
  // 毎月25日。まだ予定日が来ていない
  { id: "w", name: "排水口", schedule: { type: "calendar", rule: { kind: "monthly_day", day: 25, every: 1, anchor: "2026-10-01" } }, archivedOn: null },
];

const log = (choreId: string, userId: string, doneOn: string, deletedAt: string | null = null): StatsLog => ({ choreId, userId, doneOn, deletedAt });
const logs: StatsLog[] = [
  log("x", "a", "2026-10-01"),
  log("x", "b", "2026-10-05"),
  log("x", "a", "2026-10-08"),
  log("x", "b", "2026-10-09", "2026-10-09T01:00:00Z"), // 取り消し。数えれば 10-11 の回が期限内になってしまう
  log("x", "a", "2026-10-14"),
  log("y", "c", "2026-10-04"),
  log("y", "b", "2026-10-19"),
  log("z", "a", "2026-09-25"),
  log("z", "a", "2026-10-04"),
];

const input = (over: Partial<StatsInput> = {}): StatsInput => ({
  chores,
  logs,
  users: [
    { userId: "a", name: "たくみ", isMember: true },
    { userId: "b", name: "はなこ", isMember: true },
    { userId: "d", name: "じろう", isMember: true },
    { userId: "c", name: "前の人", isMember: false },
    { userId: "e", name: "昔の人", isMember: false },
  ],
  from: "2026-10-01",
  to: "2026-10-31",
  today,
  ...over,
});

describe("統計（今月）", () => {
  const s = computeStats(input());

  it("分担：人ごとの回数と割合。記録の無いメンバーは 0、抜けた人は記録があれば名前で出る", () => {
    expect(s.totalCount).toBe(7);
    expect(s.people).toEqual([
      { userId: "a", name: "たくみ", isMember: true, count: 4, share: 57 },
      { userId: "b", name: "はなこ", isMember: true, count: 2, share: 29 },
      { userId: "d", name: "じろう", isMember: true, count: 0, share: 0 },
      { userId: "c", name: "前の人", isMember: false, count: 1, share: 14 },
    ]);
  });

  it("担当の偏り：家事ごとの人別回数。記録の無い家事は出ない。しまった家事も出る", () => {
    expect(s.byChore).toEqual([
      { choreId: "x", name: "風呂掃除", archived: false, count: 4, byUser: [{ userId: "a", count: 3 }, { userId: "b", count: 1 }] },
      { choreId: "y", name: "シーツ交換", archived: false, count: 2, byUser: [{ userId: "c", count: 1 }, { userId: "b", count: 1 }] },
      { choreId: "z", name: "植木の水やり", archived: true, count: 1, byUser: [{ userId: "a", count: 1 }] },
    ]);
  });

  it("守り具合：期間内に期限がある8回（遅れ 0,1,0,3 / 0,1 / 2 と missed 1）", () => {
    // 期限内 3回 ÷ 8回 ＝ 37.5% → 38。平均の遅れ ＝ 7日 ÷ 7回 ＝ 1.0
    expect(s.punctuality).toEqual({ judgedCount: 8, onTimeCount: 3, onTimeRate: 38, averageDaysLate: 1, missedCount: 1 });
  });

  it("推移：週は月曜始まり（期間の外の日も週の頭に出る）、月ごと", () => {
    expect(s.weekly).toEqual([
      { weekStart: "2026-09-28", count: 3 }, // 10-01, 10-04, 10-04
      { weekStart: "2026-10-05", count: 2 },
      { weekStart: "2026-10-12", count: 1 },
      { weekStart: "2026-10-19", count: 1 },
      { weekStart: "2026-10-26", count: 0 },
    ]);
    expect(s.monthly).toEqual([{ month: "2026-10", count: 7 }]);
  });

  it("よく遅れる家事：平均の遅れ＋missed の多い順。遅れの無い家事は出ない", () => {
    expect(s.lateRanking.map((r) => [r.name, r.score, r.averageDaysLate, r.missedCount, r.onTimeRate])).toEqual([
      ["植木の水やり", 2, 2, 0, 0],
      ["シーツ交換", 1.5, 0.5, 1, 33],
      ["風呂掃除", 1, 1, 0, 50],
    ]);
  });
});

describe("統計（期間・しまった家事）", () => {
  it("全期間：推移はいちばん古い日から。期間の前の回も入る", () => {
    const s = computeStats(input({ from: "2000-01-01" }));
    expect(s.totalCount).toBe(8);
    expect(s.weekly[0]).toEqual({ weekStart: "2026-09-14", count: 0 }); // 09-20（日）を含む週
    expect(s.weekly[1]).toEqual({ weekStart: "2026-09-21", count: 1 });
    expect(s.weekly).toHaveLength(7); // 09-14 〜 10-26
    expect(s.monthly).toEqual([
      { month: "2026-09", count: 1 },
      { month: "2026-10", count: 7 },
    ]);
    // 09-20 の回（5日遅れ）が増える：9回、期限内 3、遅れの合計 12 ÷ 8回 ＝ 1.5
    expect(s.punctuality).toEqual({ judgedCount: 9, onTimeCount: 3, onTimeRate: 33, averageDaysLate: 1.5, missedCount: 1 });
    expect(s.lateRanking[0]).toMatchObject({ name: "植木の水やり", averageDaysLate: 3.5, score: 3.5 });
  });

  it("しまった家事は、しまった日より後の予定日を数えない", () => {
    const archivedY = chores.map((c) => (c.id === "y" ? { ...c, archivedOn: "2026-10-12" } : c));
    const s = computeStats(input({ chores: archivedY }));
    // 10-11 の回は 10-12 の時点でまだ開いている → 数えない。10-18 の回も数えない
    expect(s.lateRanking.map((r) => r.choreId)).toEqual(["z", "x"]);
    expect(s.punctuality).toMatchObject({ judgedCount: 6, missedCount: 0 });
    // 記録の回数（分担）は残る
    expect(s.byChore.find((c) => c.choreId === "y")).toMatchObject({ archived: true, count: 2 });
  });

  it("記録が無ければ 0 と null", () => {
    const s = computeStats(input({ logs: [], from: "2026-11-01", to: "2026-11-30" }));
    expect(s.totalCount).toBe(0);
    expect(s.people.map((p) => [p.userId, p.count, p.share])).toEqual([
      ["a", 0, 0],
      ["b", 0, 0],
      ["d", 0, 0],
    ]);
    expect(s.punctuality).toEqual({ judgedCount: 0, onTimeCount: 0, onTimeRate: null, averageDaysLate: null, missedCount: 0 });
    expect(s.monthly).toEqual([{ month: "2026-11", count: 0 }]);
    expect(s.lateRanking).toEqual([]);
  });

  it("ランキングは上位10まで", () => {
    const many: StatsChore[] = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: `家事${i}`, schedule: interval(30, "2026-10-01"), archivedOn: null }));
    const manyLogs = many.map((c, i) => log(c.id, "a", `2026-10-${String(2 + i).padStart(2, "0")}`)); // 遅れ 1〜12日
    const s = computeStats(input({ chores: many, logs: manyLogs }));
    expect(s.lateRanking).toHaveLength(10);
    expect(s.lateRanking[0]).toMatchObject({ name: "家事11", score: 12 });
    expect(s.lateRanking[9]).toMatchObject({ name: "家事2", score: 3 });
  });

  it("今月の初日と末日", () => {
    expect(monthRange("2026-02-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRange("2026-10-07")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });
});
