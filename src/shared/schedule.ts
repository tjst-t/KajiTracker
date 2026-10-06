// 期限の計算。説明は docs/design.md の 2。
// 画面・API・Cron（通知）・統計で同じ関数を使う。副作用は持たない。
import { type DateStr, type DayNum, daysInMonth, fromDayNum, isDateStr, toDayNum, weekdayOf, ymdOf } from "./date";

// ---- 周期の決め方 ----

export type CalendarRule =
  /** 毎週（every=2 で隔週）。weekdays は 0=日〜6=土 */
  | { kind: "weekly"; weekdays: number[]; every: number; anchor: DateStr }
  /** 毎月第n○曜日（nth=-1 で最終○曜日）。every=3 で3か月ごと */
  | { kind: "monthly_nth_weekday"; nth: 1 | 2 | 3 | 4 | 5 | -1; weekday: number; every: number; anchor: DateStr }
  /** 毎月○日（day=-1 で月末）。その月に無い日は月末に寄せる */
  | { kind: "monthly_day"; day: number; every: number; anchor: DateStr };

export type Schedule =
  | { type: "interval"; intervalDays: number; firstDueOn: DateStr }
  | { type: "calendar"; rule: CalendarRule };

/** 外から来た値（API の入力・D1 の JSON）を CalendarRule として確かめる。だめなら Error */
export function parseCalendarRule(v: unknown): CalendarRule {
  const fail = (why: string): never => {
    throw new Error(`カレンダーの規則が正しくない: ${why}`);
  };
  if (typeof v !== "object" || v === null) fail("オブジェクトでない");
  const o = v as Record<string, unknown>;
  const every = o.every ?? 1;
  if (!Number.isInteger(every) || (every as number) < 1 || (every as number) > 24) fail("every は 1〜24");
  if (!isDateStr(o.anchor)) fail("anchor が日付でない");
  const isWeekday = (x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 6;
  const base = { every: every as number, anchor: o.anchor as DateStr };
  switch (o.kind) {
    case "weekly": {
      const wd = o.weekdays;
      if (!Array.isArray(wd) || wd.length === 0 || !wd.every(isWeekday)) fail("weekdays は 0〜6 の配列（1つ以上）");
      return { kind: "weekly", weekdays: [...new Set(wd as number[])].sort(), ...base };
    }
    case "monthly_nth_weekday": {
      if (![1, 2, 3, 4, 5, -1].includes(o.nth as number)) fail("nth は 1〜5 か -1");
      if (!isWeekday(o.weekday)) fail("weekday は 0〜6");
      return { kind: "monthly_nth_weekday", nth: o.nth as 1, weekday: o.weekday as number, ...base };
    }
    case "monthly_day": {
      const d = o.day;
      if (!(Number.isInteger(d) && ((d as number) === -1 || ((d as number) >= 1 && (d as number) <= 31)))) fail("day は 1〜31 か -1");
      return { kind: "monthly_day", day: d as number, ...base };
    }
    default:
      return fail(`kind が不明: ${String(o.kind)}`);
  }
}

// ---- カレンダーの予定日 ----

/** その日が予定日か。anchor より前は予定日にしない（登録より前に遅れが出ないように） */
export function isOccurrence(rule: CalendarRule, n: DayNum): boolean {
  const a = toDayNum(rule.anchor);
  if (n < a) return false;
  const { y, m, d } = ymdOf(n);
  switch (rule.kind) {
    case "weekly": {
      if (!rule.weekdays.includes(weekdayOf(n))) return false;
      const weeks = (n - weekdayOf(n) - (a - weekdayOf(a))) / 7;
      return weeks % rule.every === 0;
    }
    case "monthly_nth_weekday":
    case "monthly_day": {
      const am = ymdOf(a);
      const months = y * 12 + m - (am.y * 12 + am.m);
      if (months % rule.every !== 0) return false;
      const dim = daysInMonth(y, m);
      if (rule.kind === "monthly_day") {
        const target = rule.day === -1 || rule.day > dim ? dim : rule.day;
        return d === target;
      }
      if (weekdayOf(n) !== rule.weekday) return false;
      return rule.nth === -1 ? d + 7 > dim : Math.ceil(d / 7) === rule.nth;
    }
  }
}

/** 予定日を探す範囲の上限（これ以上離れていれば「予定日が無い」とみなす） */
function searchLimit(rule: CalendarRule): number {
  return rule.kind === "weekly" ? 7 * rule.every : 31 * 12 * rule.every + 31;
}

/** from より後（from を含まない）の最初の予定日 */
export function nextOccurrenceAfter(rule: CalendarRule, from: DayNum): DayNum | null {
  const start = Math.max(from + 1, toDayNum(rule.anchor));
  const limit = searchLimit(rule);
  for (let n = start; n <= start + limit; n++) if (isOccurrence(rule, n)) return n;
  return null;
}

/** from 以前（from を含む）の最後の予定日 */
export function prevOccurrenceOnOrBefore(rule: CalendarRule, from: DayNum): DayNum | null {
  const a = toDayNum(rule.anchor);
  const limit = searchLimit(rule);
  for (let n = from; n >= a && n >= from - limit; n--) if (isOccurrence(rule, n)) return n;
  return null;
}

// ---- 評価 ----

/** 1回分の結果（統計で使う） */
export type Cycle = {
  dueOn: DateStr;
  /** やった日。やっていなければ null */
  doneOn: DateStr | null;
  /** 遅れ日数（期限内・前倒しなら 0）。やっていなければ null */
  daysLate: number | null;
  /** カレンダー固定で、次の予定日が来て打ち切られた回 */
  missed: boolean;
};

export type Status =
  /** 期限を過ぎている */
  | "overdue"
  /** 今日が期限 */
  | "today"
  /** まだ先 */
  | "upcoming"
  /** 予定日が見つからない（規則がほぼ当たらない場合） */
  | "none";

export type Evaluation = {
  dueOn: DateStr | null;
  status: Status;
  /** 遅れ日数（overdue のときだけ正） */
  daysLate: number;
  /** 終わった回・打ち切られた回・前倒しで済ませた回（古い順）。いま開いている回は含まない */
  cycles: Cycle[];
};

/**
 * 家事の状態を出す。
 * @param doneOns 取り消していない記録のやった日（順不同）。今日より後の日付は無視する
 * @param today 日本時間の今日
 */
export function evaluate(schedule: Schedule, doneOns: readonly DateStr[], today: DateStr): Evaluation {
  const t = toDayNum(today);
  const logs = doneOns.map(toDayNum).filter((n) => n <= t).sort((a, b) => a - b);
  return schedule.type === "interval" ? evaluateInterval(schedule, logs, t) : evaluateCalendar(schedule.rule, logs, t);
}

function statusOf(due: DayNum | null, t: DayNum): Pick<Evaluation, "dueOn" | "status" | "daysLate"> {
  if (due === null) return { dueOn: null, status: "none", daysLate: 0 };
  if (due < t) return { dueOn: fromDayNum(due), status: "overdue", daysLate: t - due };
  return { dueOn: fromDayNum(due), status: due === t ? "today" : "upcoming", daysLate: 0 };
}

/** 前回からの日数：次の期限 ＝ 最後にやった日 ＋ N日（記録が無ければ最初の期限） */
function evaluateInterval(s: Extract<Schedule, { type: "interval" }>, logs: DayNum[], t: DayNum): Evaluation {
  let due = toDayNum(s.firstDueOn);
  const cycles: Cycle[] = [];
  for (const done of logs) {
    cycles.push({ dueOn: fromDayNum(due), doneOn: fromDayNum(done), daysLate: Math.max(0, done - due), missed: false });
    due = done + s.intervalDays;
  }
  return { ...statusOf(due, t), cycles };
}

/**
 * カレンダー固定。
 * - 記録は「その日以前で最新の予定日」の回に入る。
 * - その回がもう済んでいれば（または予定日がまだ無ければ）、次の予定日の分の前倒しになる。前倒しは1回分だけ。
 * - 次の予定日が来ても済んでいない回は打ち切り（missed）。
 */
function evaluateCalendar(rule: CalendarRule, logs: DayNum[], t: DayNum): Evaluation {
  const done = new Map<DayNum, DayNum>(); // 予定日 → やった日

  for (const d of logs) {
    const cur = prevOccurrenceOnOrBefore(rule, d);
    if (cur !== null && !done.has(cur)) {
      done.set(cur, d);
      continue;
    }
    const next = nextOccurrenceAfter(rule, cur ?? d);
    if (next !== null && !done.has(next)) done.set(next, d);
    // それ以上の前倒しは期限に効かない（記録としては残る）
  }

  const cycles: Cycle[] = [];
  const first = nextOccurrenceAfter(rule, toDayNum(rule.anchor) - 1);
  const current = prevOccurrenceOnOrBefore(rule, t);

  // 今日以前の予定日を古い順にたどる
  for (let o = first; o !== null && o <= t; o = nextOccurrenceAfter(rule, o)) {
    const d = done.get(o);
    if (d !== undefined) cycles.push({ dueOn: fromDayNum(o), doneOn: fromDayNum(d), daysLate: Math.max(0, d - o), missed: false });
    else if (o !== current) cycles.push({ dueOn: fromDayNum(o), doneOn: null, daysLate: null, missed: true });
  }

  // いま開いている回
  if (current !== null && !done.has(current)) return { ...statusOf(current, t), cycles };

  // 次の期限：まだ済んでいない最初の予定日（前倒し済みなら飛ばす）
  let next = nextOccurrenceAfter(rule, current ?? t);
  while (next !== null && done.has(next)) {
    const d = done.get(next)!;
    cycles.push({ dueOn: fromDayNum(next), doneOn: fromDayNum(d), daysLate: 0, missed: false });
    next = nextOccurrenceAfter(rule, next);
  }
  return { ...statusOf(next, t), cycles };
}
