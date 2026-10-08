// Family 全体の統計。仕様は docs/spec.md「統計」、返す形は docs/design.md の 5「統計」。
// 期限の守り具合は src/shared/schedule.ts の evaluate の「回」から出す（家事ごとの統計 choreStats と同じ数え方）。副作用は持たない。
//
// しまった家事も含める（docs/design.md の 1：しまっても記録と統計は残す）。
// ただし期限の計算は、しまった日で打ち切る（しまったあとの予定日を「やらなかった」と数えないように）。
import { type DateStr, type DayNum, daysInMonth, fromDayNum, toDayNum, weekdayOf, ymdOf } from "./date";
import { type Cycle, type Schedule, evaluate } from "./schedule";

export type StatsChore = {
  id: string;
  name: string;
  schedule: Schedule;
  /** しまった日（日本時間）。しまっていなければ null */
  archivedOn: DateStr | null;
};

export type StatsLog = {
  choreId: string;
  userId: string;
  doneOn: DateStr;
  /** 取り消した記録は数えない */
  deletedAt: string | null;
};

export type StatsUser = {
  userId: string;
  name: string;
  /** いまもメンバーか（抜けた人の記録も名前で出す） */
  isMember: boolean;
};

export type StatsInput = {
  chores: readonly StatsChore[];
  logs: readonly StatsLog[];
  /** いまのメンバー（この順で出す）と、記録のある抜けた人 */
  users: readonly StatsUser[];
  /** 期間（日本時間の日付、両端を含む） */
  from: DateStr;
  to: DateStr;
  /** 日本時間の今日 */
  today: DateStr;
};

/** 期限の守り具合。choreStats と同じ数え方 */
export type Punctuality = {
  /** 期限内にできた回・遅れてできた回・やらずに過ぎた回の合計 */
  judgedCount: number;
  onTimeCount: number;
  /** 期限内にできた率（%、整数）。回が無ければ null */
  onTimeRate: number | null;
  /** できた回の平均の遅れ日数（小数1桁）。できた回が無ければ null */
  averageDaysLate: number | null;
  missedCount: number;
};

export type Stats = {
  from: DateStr;
  to: DateStr;
  /** 期間内の記録の数 */
  totalCount: number;
  /** 人ごとの実施回数と割合（%、整数。記録が無ければ 0） */
  people: (StatsUser & { count: number; share: number })[];
  /** 家事ごとの人別回数（担当の偏り）。期間内に記録のある家事だけ、回数の多い順 */
  byChore: { choreId: string; name: string; archived: boolean; count: number; byUser: { userId: string; count: number }[] }[];
  /** 期間内に期限がある回の守り具合（全体） */
  punctuality: Punctuality;
  /** 週ごと（月曜始まり、weekStart は月曜の日付）と月ごと（"YYYY-MM"）の実施回数。古い順 */
  weekly: { weekStart: DateStr; count: number }[];
  monthly: { month: string; count: number }[];
  /** よく遅れる家事。score ＝ 平均の遅れ日数 ＋ missed の回数。score が 0 より大きいものを多い順に上位10 */
  lateRanking: ({ choreId: string; name: string; archived: boolean; score: number } & Punctuality)[];
};

export const RANKING_SIZE = 10;

/** 統計の期間の始めにできるいちばん古い日（「全期間」はここから）。推移を1日ずつ数えるので、期間の長さをこれと今日で抑える */
export const STATS_MIN_DATE: DateStr = "2000-01-01";

const round1 = (x: number) => Math.round(x * 10) / 10;
const percent = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

function punctuality(cycles: readonly Cycle[]): Punctuality {
  const done = cycles.filter((c): c is Cycle & { daysLate: number } => c.daysLate !== null);
  const missedCount = cycles.filter((c) => c.missed).length;
  const judgedCount = done.length + missedCount;
  const onTimeCount = done.filter((c) => c.daysLate === 0).length;
  return {
    judgedCount,
    onTimeCount,
    onTimeRate: judgedCount ? percent(onTimeCount, judgedCount) : null,
    averageDaysLate: done.length ? round1(done.reduce((a, c) => a + c.daysLate, 0) / done.length) : null,
    missedCount,
  };
}

/** その日を含む週の月曜 */
function mondayOf(n: DayNum): DayNum {
  return n - ((weekdayOf(n) + 6) % 7);
}

const monthOf = (d: DateStr) => d.slice(0, 7);

/** 記録・家事のいちばん古い日。推移はここから数える（「全期間」で空の週が並ばないように） */
function firstActivity(chores: readonly StatsChore[], logs: readonly StatsLog[]): DateStr | null {
  const starts = [
    ...logs.map((l) => l.doneOn),
    ...chores.map((c) => (c.schedule.type === "interval" ? c.schedule.firstDueOn : c.schedule.rule.anchor)),
  ];
  return starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : null;
}

export function computeStats(input: StatsInput): Stats {
  const { chores, users, from, to, today } = input;
  const live = input.logs.filter((l) => l.deletedAt === null);
  const inPeriod = live.filter((l) => l.doneOn >= from && l.doneOn <= to);

  // ---- 分担 ----
  const countByUser = new Map<string, number>();
  for (const l of inPeriod) countByUser.set(l.userId, (countByUser.get(l.userId) ?? 0) + 1);
  const known = new Set(users.map((u) => u.userId));
  const unknown: StatsUser[] = [...countByUser.keys()].filter((id) => !known.has(id)).map((userId) => ({ userId, name: "（不明）", isMember: false }));
  const people = [...users, ...unknown]
    // 抜けた人は記録があるときだけ出す
    .filter((u) => u.isMember || countByUser.has(u.userId))
    .map((u) => {
      const count = countByUser.get(u.userId) ?? 0;
      return { ...u, count, share: percent(count, inPeriod.length) };
    });

  const byChore = chores
    .map((c) => {
      const mine = inPeriod.filter((l) => l.choreId === c.id);
      const per = new Map<string, number>();
      for (const l of mine) per.set(l.userId, (per.get(l.userId) ?? 0) + 1);
      const byUser = [...per].map(([userId, count]) => ({ userId, count })).sort((a, b) => b.count - a.count);
      return { choreId: c.id, name: c.name, archived: c.archivedOn !== null, count: mine.length, byUser };
    })
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);

  // ---- 期限の守り具合 ----
  // 回を出すには期間の前の記録も要る（次の期限は前の記録で決まる）ので、取り消していない記録をすべて渡す
  const all: Cycle[] = [];
  const perChore = chores.map((c) => {
    const until = c.archivedOn !== null && c.archivedOn < today ? c.archivedOn : today;
    const doneOns = live.filter((l) => l.choreId === c.id).map((l) => l.doneOn);
    const cycles = evaluate(c.schedule, doneOns, until).cycles.filter((cy) => cy.dueOn >= from && cy.dueOn <= to);
    all.push(...cycles);
    const p = punctuality(cycles);
    return { choreId: c.id, name: c.name, archived: c.archivedOn !== null, score: round1((p.averageDaysLate ?? 0) + p.missedCount), ...p };
  });
  const lateRanking = perChore
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || b.missedCount - a.missedCount || a.name.localeCompare(b.name, "ja"))
    .slice(0, RANKING_SIZE);

  // ---- 推移 ----
  const first = firstActivity(chores, live);
  // 最初の記録・期限が期間より後でも、期間の外（to より後）の週・月は出さない
  const end = toDayNum(to);
  const start = Math.min(toDayNum(first !== null && first > from ? first : from), end);
  const weekCount = new Map<DayNum, number>();
  const monthCount = new Map<string, number>();
  for (let w = mondayOf(start); w <= end; w += 7) weekCount.set(w, 0);
  for (let n = start; n <= end; n++) monthCount.set(monthOf(fromDayNum(n)), 0);
  for (const l of inPeriod) {
    const n = toDayNum(l.doneOn);
    const w = mondayOf(n);
    weekCount.set(w, (weekCount.get(w) ?? 0) + 1);
    monthCount.set(monthOf(l.doneOn), (monthCount.get(monthOf(l.doneOn)) ?? 0) + 1);
  }

  return {
    from,
    to,
    totalCount: inPeriod.length,
    people,
    byChore,
    punctuality: punctuality(all),
    weekly: [...weekCount].map(([w, count]) => ({ weekStart: fromDayNum(w), count })),
    monthly: [...monthCount].map(([month, count]) => ({ month, count })),
    lateRanking,
  };
}

/** 日本時間のその日を含む月の初日と末日 */
export function monthRange(d: DateStr): { from: DateStr; to: DateStr } {
  const { y, m } = ymdOf(toDayNum(d));
  const ym = monthOf(d);
  return { from: `${ym}-01`, to: `${ym}-${String(daysInMonth(y, m)).padStart(2, "0")}` };
}
