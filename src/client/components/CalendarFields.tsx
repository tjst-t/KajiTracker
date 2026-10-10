// カレンダー固定の規則の入力欄。家事の登録画面と、まとめて登録・表で編集の小さな画面で使う
import { addDays, toDayNum, weekdayOf } from "../../shared/date";
import { WEEKDAYS } from "../../shared/describe";
import { type CalendarRule, NTHS, type Nth, nextOccurrenceAfter, sortNths } from "../../shared/schedule";

type Kind = CalendarRule["kind"];
/** 毎月の規則の月の決め方：毎月・nか月ごと・月を選ぶ */
type MonthMode = "monthly" | "every" | "months";

export type CalState = {
  kind: Kind;
  /** 毎週と第何週の何曜日で使う */
  weekdays: number[];
  everyWeeks: number;
  nths: Nth[];
  day: number;
  monthMode: MonthMode;
  /** nか月ごとの n（2〜24） */
  everyMonths: number;
  /** 月を選ぶときの月（1〜12） */
  months: number[];
  /** 隔週・数か月ごとの最初の予定日。空なら候補を使う */
  anchor: string;
};

export function initialCal(today: string, rule?: CalendarRule): CalState {
  const wd = weekdayOf(toDayNum(today));
  const s: CalState = { kind: "weekly", weekdays: [wd], everyWeeks: 1, nths: [1], day: 1, monthMode: "monthly", everyMonths: 2, months: [], anchor: "" };
  if (!rule) return s;
  s.kind = rule.kind;
  if (rule.kind === "weekly") {
    s.weekdays = rule.weekdays;
    s.everyWeeks = rule.every;
  } else {
    if (rule.months) {
      s.monthMode = "months";
      s.months = rule.months;
    } else if (rule.every >= 2) {
      s.monthMode = "every";
      s.everyMonths = rule.every;
    }
    if (rule.kind === "monthly_nth_weekday") {
      s.nths = rule.nths;
      s.weekdays = rule.weekdays;
    } else s.day = rule.day;
  }
  if (rule.every >= 2) s.anchor = rule.anchor;
  return s;
}

export const everyOfCal = (s: CalState) => (s.kind === "weekly" ? s.everyWeeks : s.monthMode === "every" ? s.everyMonths : 1);

export function ruleOfCal(s: CalState, anchor: string): CalendarRule {
  if (s.kind === "weekly") return { kind: "weekly", weekdays: [...s.weekdays].sort((a, b) => a - b), every: s.everyWeeks, anchor };
  const month = s.monthMode === "months" ? { every: 1, anchor, months: [...s.months].sort((a, b) => a - b) } : { every: everyOfCal(s), anchor };
  if (s.kind === "monthly_nth_weekday") return { kind: "monthly_nth_weekday", nths: sortNths(s.nths), weekdays: [...s.weekdays].sort((a, b) => a - b), ...month };
  return { kind: "monthly_day", day: s.day, ...month };
}

/** 隔週・数か月ごとの「最初の予定日」の候補（今日以降で最初に当たる日） */
export function suggestedAnchor(s: CalState, today: string): string {
  const n = nextOccurrenceAfter(ruleOfCal({ ...s, everyWeeks: 1, monthMode: s.monthMode === "every" ? "monthly" : s.monthMode }, today), toDayNum(today) - 1);
  return n === null ? today : addDays("1970-01-01", n);
}

/** いまの入力での基準日（毎週・毎月は今日、隔週・数か月ごとは選んだ日か候補） */
export function anchorOfCal(s: CalState, today: string): string {
  return everyOfCal(s) >= 2 ? s.anchor || suggestedAnchor(s, today) : today;
}

/** API に送る規則。毎週・毎月・月を選ぶは基準日を省く（サーバが登録した日にする） */
export function ruleForApi(s: CalState, today: string) {
  const r = ruleOfCal(s, anchorOfCal(s, today));
  return everyOfCal(s) >= 2 ? r : { ...r, anchor: undefined };
}

/** 決められないわけ。決められるなら null */
export function calError(s: CalState): string | null {
  if (s.kind !== "monthly_day" && s.weekdays.length === 0) return "曜日を1つ以上選んでください";
  if (s.kind === "monthly_nth_weekday" && s.nths.length === 0) return "第何週を1つ以上選んでください";
  if (s.kind !== "weekly" && s.monthMode === "months" && s.months.length === 0) return "月を1つ以上選んでください";
  if (s.kind !== "weekly" && s.monthMode === "every" && !(Number.isInteger(s.everyMonths) && s.everyMonths >= 2 && s.everyMonths <= 24)) return "何か月ごとは 2〜24 で入れてください";
  return null;
}

export const calValid = (s: CalState) => calError(s) === null;

const toggled = <T,>(xs: T[], x: T, on: boolean) => (on ? [...xs.filter((y) => y !== x), x] : xs.filter((y) => y !== x));

/** 丸いトグル（複数選べる）。読み上げでは label の名前のチェックボックスになる */
function Toggles<T extends number>({
  legend,
  options,
  value,
  onChange,
  id,
  className,
}: {
  legend: string;
  options: readonly { value: T; label: string }[];
  value: T[];
  onChange: (v: T[]) => void;
  id: string;
  className?: string;
}) {
  return (
    <fieldset className="fieldset">
      <legend>{legend}</legend>
      <div className={`weekdays${className ? ` ${className}` : ""}`}>
        {options.map((o) => (
          <label key={o.value} className="weekday" htmlFor={`${id}-${o.value}`}>
            <input id={`${id}-${o.value}`} type="checkbox" aria-label={o.label} checked={value.includes(o.value)} onChange={(e) => onChange(toggled(value, o.value, e.target.checked))} />
            <span aria-hidden="true">{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const WEEKDAY_OPTIONS = WEEKDAYS.map((w, i) => ({ value: i, label: w }));
const NTH_OPTIONS = NTHS.map((n) => ({ value: n, label: n === -1 ? "最終" : `第${n}` }));
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `${i + 1}月` }));

export function CalendarFields({ value: s, onChange, today, idPrefix = "cal" }: { value: CalState; onChange: (s: CalState) => void; today: string; idPrefix?: string }) {
  const set = <K extends keyof CalState>(k: K, v: CalState[K]) => onChange({ ...s, [k]: v });
  const every = everyOfCal(s);
  return (
    <div className="calendar-rule">
      <label className="field field--short">
        <span>決め方</span>
        <select value={s.kind} onChange={(e) => set("kind", e.target.value as Kind)}>
          <option value="weekly">曜日で（毎週・隔週）</option>
          <option value="monthly_nth_weekday">第何週の何曜日（毎月）</option>
          <option value="monthly_day">日付で（毎月）</option>
        </select>
      </label>

      {s.kind === "weekly" && (
        <>
          <Toggles legend="曜日" options={WEEKDAY_OPTIONS} value={s.weekdays} onChange={(v) => set("weekdays", v)} id={`${idPrefix}-wd`} />
          <label className="field field--short">
            <span>何週ごと</span>
            <select value={s.everyWeeks} onChange={(e) => set("everyWeeks", Number(e.target.value))}>
              <option value={1}>毎週</option>
              <option value={2}>隔週</option>
              <option value={3}>3週ごと</option>
              <option value={4}>4週ごと</option>
            </select>
          </label>
        </>
      )}

      {s.kind === "monthly_nth_weekday" && (
        <>
          <Toggles legend="第何週" options={NTH_OPTIONS} value={s.nths} onChange={(v) => set("nths", v)} id={`${idPrefix}-nth`} className="weekdays--wide" />
          <Toggles legend="曜日" options={WEEKDAY_OPTIONS} value={s.weekdays} onChange={(v) => set("weekdays", v)} id={`${idPrefix}-wd`} />
        </>
      )}

      {s.kind === "monthly_day" && (
        <label className="field field--short">
          <span>日付</span>
          <select value={s.day} onChange={(e) => set("day", Number(e.target.value))}>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}日{d >= 29 ? "（無い月は月末）" : ""}
              </option>
            ))}
            <option value={-1}>月末</option>
          </select>
        </label>
      )}

      {s.kind !== "weekly" && (
        <>
          <label className="field field--short">
            <span>月の決め方</span>
            <select value={s.monthMode} onChange={(e) => set("monthMode", e.target.value as MonthMode)}>
              <option value="monthly">毎月</option>
              <option value="every">nか月ごと</option>
              <option value="months">月を選ぶ</option>
            </select>
          </label>
          {s.monthMode === "every" && (
            <label className="field field--short">
              <span>何か月ごと（2〜24）</span>
              <span className="cycle-cell">
                <input type="number" min={2} max={24} value={Number.isNaN(s.everyMonths) ? "" : s.everyMonths} onChange={(e) => set("everyMonths", e.target.value === "" ? Number.NaN : Number(e.target.value))} />
                か月ごと
              </span>
            </label>
          )}
          {s.monthMode === "months" && <Toggles legend="月" options={MONTH_OPTIONS} value={s.months} onChange={(v) => set("months", v)} id={`${idPrefix}-month`} className="weekdays--months" />}
        </>
      )}

      {every >= 2 && (
        <label className="field field--short">
          <span>最初の予定日（ここから数えます）</span>
          <input type="date" value={anchorOfCal(s, today)} min={today} onChange={(e) => set("anchor", e.target.value)} required />
        </label>
      )}
    </div>
  );
}
