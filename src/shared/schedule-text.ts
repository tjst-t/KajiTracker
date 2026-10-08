// 周期を1つのマスの文字で書く・読む（まとめて登録の表で使う）。副作用は持たない。
// 書き方は describeSchedule と同じ（「7日ごと」「毎週 月・木曜」「隔週 土曜」「毎月 第1日曜」「3か月ごと 最終金曜」「毎月 末日」）。
// 読むほうはゆるく、全角・空白・「曜日」の有無・区切りの違いなどを受け付ける。
import { type DateStr, addDays, isDateStr, toDayNum } from "./date";
import { WEEKDAYS, describeSchedule } from "./describe";
import { type CalendarRule, type Schedule, nextOccurrenceAfter } from "./schedule";

/** 日数の上限（約10年） */
export const MAX_INTERVAL_DAYS = 3660;
/** 「N週ごと」「Nか月ごと」の上限（parseCalendarRule と同じ） */
const MAX_EVERY = 24;

/** anchor を除いたカレンダーの規則 */
export type CalendarRuleText = CalendarRule extends infer R ? (R extends CalendarRule ? Omit<R, "anchor"> : never) : never;

export type ParsedScheduleText =
  | { ok: true; kind: "interval"; intervalDays: number }
  | {
      ok: true;
      kind: "calendar";
      /** anchor は入れない。毎週・毎月は呼ぶ側が省いて送る */
      rule: CalendarRuleText;
      /** 隔週・数か月ごと（every≥2）は基準日（最初の予定日）が要る */
      needsAnchor: boolean;
      /** needsAnchor のときの基準日の候補（今日以降で最初に当たる日） */
      suggestedAnchor?: DateStr;
    }
  | { ok: false; message: string };

/** 周期を表に出す文字にする */
export function formatScheduleText(s: Schedule): string {
  return describeSchedule(s);
}

const EXAMPLES = "例：7日ごと、毎週 月・木、隔週 土、毎月 1日、毎月 第2火曜、毎月 末日";
const fail = (message: string): ParsedScheduleText => ({ ok: false, message });

/** 全角→半角、空白を消す、言い回しをそろえる */
function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/(\d+)[かヶカヵケ箇]月/g, "$1か月")
    .replace(/曜日/g, "曜");
}

/** 「月・木曜」「月木」「土日」「平日」などを曜日の番号（0=日〜6=土）にする。読めなければ null */
function parseWeekdays(body: string): number[] | null {
  const s = body.replace(/平日/g, "月火水木金").replace(/[・、,/と]/g, "");
  if (!/^(?:[日月火水木金土]曜?)+$/.test(s)) return null;
  const days = [...s.replace(/曜/g, "")].map((c) => WEEKDAYS.indexOf(c as (typeof WEEKDAYS)[number]));
  return [...new Set(days)].sort((a, b) => a - b);
}

function interval(n: number): ParsedScheduleText {
  if (!Number.isInteger(n) || n < 1 || n > MAX_INTERVAL_DAYS) return fail(`日数は1〜${MAX_INTERVAL_DAYS}で書いてください`);
  return { ok: true, kind: "interval", intervalDays: n };
}

function calendar(rule: CalendarRuleText, today: DateStr): ParsedScheduleText {
  if (rule.every < 1 || rule.every > MAX_EVERY) {
    return fail(rule.kind === "weekly" ? `週の間隔は1〜${MAX_EVERY}週で書いてください` : `月の間隔は1〜${MAX_EVERY}か月で書いてください`);
  }
  if (rule.every < 2) return { ok: true, kind: "calendar", rule, needsAnchor: false };
  // 候補：毎週・毎月として今日以降で最初に当たる日
  const n = nextOccurrenceAfter({ ...rule, every: 1, anchor: today } as CalendarRule, toDayNum(today) - 1);
  return { ok: true, kind: "calendar", rule, needsAnchor: true, suggestedAnchor: n === null ? today : addDays("1970-01-01", n) };
}

/**
 * 表のマスの文字を周期に戻す。
 * 「1日」だけは毎月1日、それ以外の「N日」は N日ごととして読む。
 * @param today 日本時間の今日（隔週・数か月ごとの基準日の候補に使う）
 */
export function parseScheduleText(text: string, today: DateStr): ParsedScheduleText {
  const s = normalize(text);
  if (s === "") return fail("周期が空です（" + EXAMPLES + "）");

  // ---- 決まった言い回し ----
  if (s === "毎日") return interval(1);
  if (s === "隔日") return interval(2);
  if (/^週1回?$/.test(s)) return interval(7);

  // ---- 毎月・Nか月ごと ----
  const mm = s.match(/^(?:(毎月)|(隔月)|(\d+)か月(?:ごと|おき|毎)?)?(.*)$/)!;
  const hasMonthPrefix = mm[1] !== undefined || mm[2] !== undefined || mm[3] !== undefined;
  const everyMonths = mm[2] !== undefined ? 2 : mm[3] !== undefined ? Number(mm[3]) : 1;
  const mBody = mm[4] ?? "";
  if (/^(?:末日|月末|末)$/.test(mBody)) return calendar({ kind: "monthly_day", day: -1, every: everyMonths }, today);
  const md = mBody.match(/^(\d+)日$/);
  if (md && (hasMonthPrefix || md[1] === "1")) {
    const day = Number(md[1]);
    if (day < 1 || day > 31) return fail("日にちは1〜31か「末日」で書いてください");
    return calendar({ kind: "monthly_day", day, every: everyMonths }, today);
  }
  const mn = mBody.match(/^(?:第(\d+)|(最終|最後の?))([日月火水木金土])曜?$/);
  if (mn) {
    const nth = mn[2] !== undefined ? -1 : Number(mn[1]);
    if (nth !== -1 && (nth < 1 || nth > 5)) return fail("第何週は第1〜第5か「最終」で書いてください");
    const weekday = WEEKDAYS.indexOf(mn[3] as (typeof WEEKDAYS)[number]);
    return calendar({ kind: "monthly_nth_weekday", nth: nth as 1 | 2 | 3 | 4 | 5 | -1, weekday, every: everyMonths }, today);
  }
  if (hasMonthPrefix) {
    return fail(mBody === "" ? "何日か、第何何曜かを書いてください（例：毎月 1日、毎月 第2火曜、毎月 末日）" : `「${text.trim()}」の日にちが読めません（例：毎月 1日、毎月 第2火曜、毎月 末日）`);
  }

  // ---- N日ごと ----
  const di = s.match(/^(\d+)(?:日(?:ごと|おき|毎|に1回)?)?$/);
  if (di) return interval(Number(di[1]));

  // ---- 毎週・隔週・N週ごと ----
  const wm = s.match(/^(?:(毎週)|(隔週)|(\d+)週(?:ごと|おき|毎)?)?(.*)$/)!;
  const hasWeekPrefix = wm[1] !== undefined || wm[2] !== undefined || wm[3] !== undefined;
  const everyWeeks = wm[2] !== undefined ? 2 : wm[3] !== undefined ? Number(wm[3]) : 1;
  const wBody = wm[4] ?? "";
  // 曜日が無ければ日数の周期（毎週＝7日ごと、3週ごと＝21日ごと）
  if (hasWeekPrefix && wBody === "") return interval(everyWeeks * 7);
  const weekdays = parseWeekdays(wBody);
  if (weekdays) return calendar({ kind: "weekly", weekdays, every: everyWeeks }, today);
  if (hasWeekPrefix) return fail(`「${text.trim()}」の曜日が読めません（例：毎週 月・木、隔週 土）`);

  return fail(`「${text.trim()}」は周期として読めません（${EXAMPLES}）`);
}

/**
 * 表のマスの日付の文字を YYYY-MM-DD にする。読めなければ null。
 * 「2026-10-20」「2026/10/20」「2026年10月20日」「10/20」「10月20日」、後ろの「（火）」も受け付ける。
 * 年が無いときは今年。ただし半年より前になるなら来年とみなす（12月に「1/5」と書いたら来年）。
 */
export function parseDateText(text: string, today: DateStr): DateStr | null {
  const s = text
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/\([日月火水木金土]曜?日?\)$/, "");
  const m = s.match(/^(?:(\d{4})[-/.年])?(\d{1,2})[-/.月](\d{1,2})日?$/);
  if (!m) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const build = (y: number) => `${y}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
  let d = build(m[1] !== undefined ? Number(m[1]) : Number(today.slice(0, 4)));
  if (!isDateStr(d)) return null;
  if (m[1] === undefined && toDayNum(d) < toDayNum(today) - 183) d = build(Number(today.slice(0, 4)) + 1);
  return isDateStr(d) ? d : null;
}
