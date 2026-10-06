// カレンダー固定の規則の入力欄。家事の登録画面と、まとめて登録の小さな画面で使う
import { addDays, toDayNum, weekdayOf } from "../../shared/date";
import { WEEKDAYS } from "../../shared/describe";
import { type CalendarRule, nextOccurrenceAfter } from "../../shared/schedule";

const NTH = [1, 2, 3, 4, 5, -1] as const;
type Kind = CalendarRule["kind"];

export type CalState = {
  kind: Kind;
  weekdays: number[];
  everyWeeks: number;
  nth: (typeof NTH)[number];
  weekday: number;
  day: number;
  everyMonths: number;
  /** 隔週・数か月ごとの最初の予定日。空なら候補を使う */
  anchor: string;
};

export function initialCal(today: string, rule?: CalendarRule): CalState {
  const wd = weekdayOf(toDayNum(today));
  const s: CalState = { kind: "weekly", weekdays: [wd], everyWeeks: 1, nth: 1, weekday: wd, day: 1, everyMonths: 1, anchor: "" };
  if (!rule) return s;
  s.kind = rule.kind;
  if (rule.kind === "weekly") {
    s.weekdays = rule.weekdays;
    s.everyWeeks = rule.every;
  } else {
    s.everyMonths = rule.every;
    if (rule.kind === "monthly_nth_weekday") {
      s.nth = rule.nth;
      s.weekday = rule.weekday;
    } else s.day = rule.day;
  }
  if (rule.every >= 2) s.anchor = rule.anchor;
  return s;
}

export const everyOfCal = (s: CalState) => (s.kind === "weekly" ? s.everyWeeks : s.everyMonths);

export function ruleOfCal(s: CalState, anchor: string): CalendarRule {
  if (s.kind === "weekly") return { kind: "weekly", weekdays: [...s.weekdays].sort(), every: s.everyWeeks, anchor };
  if (s.kind === "monthly_nth_weekday") return { kind: "monthly_nth_weekday", nth: s.nth, weekday: s.weekday, every: s.everyMonths, anchor };
  return { kind: "monthly_day", day: s.day, every: s.everyMonths, anchor };
}

/** 隔週・数か月ごとの「最初の予定日」の候補（今日以降で最初に当たる日） */
export function suggestedAnchor(s: CalState, today: string): string {
  const n = nextOccurrenceAfter(ruleOfCal({ ...s, everyWeeks: 1, everyMonths: 1 }, today), toDayNum(today) - 1);
  return n === null ? today : addDays("1970-01-01", n);
}

/** いまの入力での基準日（毎週・毎月は今日、隔週・数か月ごとは選んだ日か候補） */
export function anchorOfCal(s: CalState, today: string): string {
  return everyOfCal(s) >= 2 ? s.anchor || suggestedAnchor(s, today) : today;
}

/** API に送る規則。毎週・毎月は基準日を省く（サーバが登録した日にする） */
export function ruleForApi(s: CalState, today: string) {
  const r = ruleOfCal(s, anchorOfCal(s, today));
  return everyOfCal(s) >= 2 ? r : { ...r, anchor: undefined };
}

export const calValid = (s: CalState) => !(s.kind === "weekly" && s.weekdays.length === 0);

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
          <fieldset className="fieldset">
            <legend>曜日</legend>
            <div className="weekdays">
              {WEEKDAYS.map((w, i) => (
                <label key={w} className="weekday" htmlFor={`${idPrefix}-wd-${i}`}>
                  <input
                    id={`${idPrefix}-wd-${i}`}
                    type="checkbox"
                    aria-label={w}
                    checked={s.weekdays.includes(i)}
                    onChange={(e) => set("weekdays", e.target.checked ? [...s.weekdays, i] : s.weekdays.filter((d) => d !== i))}
                  />
                  <span aria-hidden="true">{w}</span>
                </label>
              ))}
            </div>
          </fieldset>
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
        <div className="row-form">
          <label className="field field--short">
            <span>第何週</span>
            <select value={s.nth} onChange={(e) => set("nth", Number(e.target.value) as CalState["nth"])}>
              {NTH.map((n) => (
                <option key={n} value={n}>
                  {n === -1 ? "最終" : `第${n}`}
                </option>
              ))}
            </select>
          </label>
          <label className="field field--short">
            <span>曜日</span>
            <select value={s.weekday} onChange={(e) => set("weekday", Number(e.target.value))}>
              {WEEKDAYS.map((w, i) => (
                <option key={w} value={i}>
                  {w}曜
                </option>
              ))}
            </select>
          </label>
        </div>
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
        <label className="field field--short">
          <span>何か月ごと</span>
          <select value={s.everyMonths} onChange={(e) => set("everyMonths", Number(e.target.value))}>
            {[1, 2, 3, 4, 6, 12].map((n) => (
              <option key={n} value={n}>
                {n === 1 ? "毎月" : `${n}か月ごと`}
              </option>
            ))}
          </select>
        </label>
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
