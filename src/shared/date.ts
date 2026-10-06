// 日付は日本時間の "YYYY-MM-DD" の文字列で持つ。計算は 1970-01-01 からの日数（DayNum）で行う。
export type DateStr = string;
export type DayNum = number;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;
const JST_OFFSET_MS = 9 * 3_600_000; // 日本に夏時間は無い

export function isDateStr(s: unknown): s is DateStr {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

export function toDayNum(s: DateStr): DayNum {
  if (!isDateStr(s)) throw new Error(`日付の形が違う: ${s}`);
  const [y, mo, d] = s.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, mo - 1, d) / MS_PER_DAY;
}

export function fromDayNum(n: DayNum): DateStr {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(s: DateStr, days: number): DateStr {
  return fromDayNum(toDayNum(s) + days);
}

/** b − a の日数 */
export function diffDays(a: DateStr, b: DateStr): number {
  return toDayNum(b) - toDayNum(a);
}

/** 0=日曜 … 6=土曜 */
export function weekdayOf(n: DayNum): number {
  return (((n + 4) % 7) + 7) % 7; // 1970-01-01 は木曜
}

export function ymdOf(n: DayNum): { y: number; m: number; d: number } {
  const dt = new Date(n * MS_PER_DAY);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** いまの日本時間の日付 */
export function todayInTokyo(now: Date = new Date()): DateStr {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}
