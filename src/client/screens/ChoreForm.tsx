import { useEffect, useMemo, useState } from "react";
import { addDays, todayInTokyo, toDayNum, weekdayOf } from "../../shared/date";
import { WEEKDAYS, describeRule, shortDate } from "../../shared/describe";
import { type CalendarRule, type Schedule, evaluate, nextOccurrenceAfter } from "../../shared/schedule";
import { type Family, type Member, api } from "../api";
import type { ChoreDetail, ChoreView } from "../chores";
import { errorText } from "../format";
import type { Nav } from "../router";

const TIMES = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`);
const NTH = [1, 2, 3, 4, 5, -1] as const;
type Kind = CalendarRule["kind"];

type FormState = {
  name: string;
  type: "interval" | "calendar";
  intervalDays: number;
  firstDueOn: string;
  kind: Kind;
  weekdays: number[];
  everyWeeks: number;
  nth: (typeof NTH)[number];
  weekday: number;
  day: number;
  everyMonths: number;
  anchor: string;
  assigneeUserId: string;
  notifyTime: string;
};

function initial(today: string, chore?: ChoreView): FormState {
  const wd = weekdayOf(toDayNum(today));
  const s: FormState = {
    name: "",
    type: "interval",
    intervalDays: 7,
    firstDueOn: today,
    kind: "weekly",
    weekdays: [wd],
    everyWeeks: 1,
    nth: 1,
    weekday: wd,
    day: 1,
    everyMonths: 1,
    anchor: "",
    assigneeUserId: "",
    notifyTime: "",
  };
  if (!chore) return s;
  s.name = chore.name;
  s.assigneeUserId = chore.assigneeUserId ?? "";
  s.notifyTime = chore.notifyTime ?? "";
  if (chore.schedule.type === "interval") {
    s.type = "interval";
    s.intervalDays = chore.schedule.intervalDays;
    s.firstDueOn = chore.dueOn ?? chore.schedule.firstDueOn;
  } else {
    const r = chore.schedule.rule;
    s.type = "calendar";
    s.kind = r.kind;
    if (r.kind === "weekly") {
      s.weekdays = r.weekdays;
      s.everyWeeks = r.every;
    } else {
      s.everyMonths = r.every;
      if (r.kind === "monthly_nth_weekday") {
        s.nth = r.nth;
        s.weekday = r.weekday;
      } else s.day = r.day;
    }
    if (r.every >= 2) s.anchor = r.anchor;
  }
  return s;
}

function ruleOf(s: FormState, anchor: string): CalendarRule {
  if (s.kind === "weekly") return { kind: "weekly", weekdays: [...s.weekdays].sort(), every: s.everyWeeks, anchor };
  if (s.kind === "monthly_nth_weekday") return { kind: "monthly_nth_weekday", nth: s.nth, weekday: s.weekday, every: s.everyMonths, anchor };
  return { kind: "monthly_day", day: s.day, every: s.everyMonths, anchor };
}

const everyOf = (s: FormState) => (s.kind === "weekly" ? s.everyWeeks : s.everyMonths);

/** S3 家事の登録・編集（主に PC で使う） */
export function ChoreForm({ family, nav, editId }: { family: Family; nav: Nav; editId?: string }) {
  const today = todayInTokyo();
  const [form, setForm] = useState<FormState | null>(editId ? null : initial(today));
  const [members, setMembers] = useState<Member[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  useEffect(() => {
    api<Member[]>("GET", `/families/${family.id}/members`)
      .then(setMembers)
      .catch(() => {});
    if (editId)
      api<ChoreDetail>("GET", `/chores/${editId}`)
        .then((c) => setForm(initial(today, c)))
        .catch((e) => setError(errorText(e)));
  }, [family.id, editId, today]);

  // 隔週・数か月ごとの「最初の予定日」の候補（今日以降で最初に当たる日）
  const suggestedAnchor = useMemo(() => {
    if (!form || form.type !== "calendar") return "";
    const n = nextOccurrenceAfter(ruleOf({ ...form, everyWeeks: 1, everyMonths: 1 }, today), toDayNum(today) - 1);
    return n === null ? today : addDays("1970-01-01", n);
  }, [form, today]);

  if (!form)
    return (
      <main className="page">
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : (
          <p aria-busy="true">読み込んでいます…</p>
        )}
      </main>
    );

  const every = everyOf(form);
  const anchor = every >= 2 ? form.anchor || suggestedAnchor : "";
  const schedule: Schedule | null =
    form.type === "interval"
      ? { type: "interval", intervalDays: form.intervalDays, firstDueOn: form.firstDueOn }
      : form.kind === "weekly" && form.weekdays.length === 0
        ? null
        : { type: "calendar", rule: ruleOf(form, anchor || today) };
  const preview = schedule ? evaluate(schedule, [], today) : null;

  const submit = async () => {
    if (!schedule) return;
    setBusy(true);
    setError(null);
    const payload = {
      name: form.name,
      schedule: schedule.type === "interval" ? schedule : { type: "calendar", rule: { ...schedule.rule, anchor: every >= 2 ? anchor : undefined } },
      assigneeUserId: form.assigneeUserId || null,
      notifyTime: form.notifyTime || null,
    };
    try {
      if (editId) {
        await api("PATCH", `/chores/${editId}`, payload);
        nav.go({ name: "chore", id: editId });
      } else {
        const c = await api<ChoreView>("POST", `/families/${family.id}/chores`, payload);
        nav.go({ name: "chore", id: c.id });
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <h1>{editId ? "家事を編集" : "家事を登録"}</h1>
      <form
        className="chore-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span>家事の名前</span>
          <input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={40} required placeholder="例：ゴミ出し、エアコンのフィルター" autoFocus={!editId} />
        </label>

        <fieldset className="fieldset">
          <legend>周期の決め方</legend>
          <label className="radio">
            <input type="radio" name="type" checked={form.type === "interval"} onChange={() => set("type", "interval")} />
            前回やった日から数える
            <span className="muted">遅れたら、その分だけ次も後ろにずれます</span>
          </label>
          <label className="radio">
            <input type="radio" name="type" checked={form.type === "calendar"} onChange={() => set("type", "calendar")} />
            カレンダーで決まった日
            <span className="muted">「毎週月・木」「毎月第1日曜」など</span>
          </label>
        </fieldset>

        {form.type === "interval" ? (
          <div className="row-form">
            <label className="field field--short">
              <span>何日ごと</span>
              <input type="number" min={1} max={3660} value={form.intervalDays} onChange={(e) => set("intervalDays", Number(e.target.value))} required />
            </label>
            <label className="field field--short">
              <span>{editId ? "次の期限" : "最初の期限"}</span>
              <input type="date" value={form.firstDueOn} onChange={(e) => set("firstDueOn", e.target.value)} required />
            </label>
          </div>
        ) : (
          <div className="calendar-rule">
            <label className="field field--short">
              <span>決め方</span>
              <select value={form.kind} onChange={(e) => set("kind", e.target.value as Kind)}>
                <option value="weekly">曜日で（毎週・隔週）</option>
                <option value="monthly_nth_weekday">第何週の何曜日（毎月）</option>
                <option value="monthly_day">日付で（毎月）</option>
              </select>
            </label>

            {form.kind === "weekly" && (
              <>
                <fieldset className="fieldset">
                  <legend>曜日</legend>
                  <div className="weekdays">
                    {WEEKDAYS.map((w, i) => (
                      <label key={w} className="weekday">
                        <input
                          type="checkbox"
                          checked={form.weekdays.includes(i)}
                          onChange={(e) => set("weekdays", e.target.checked ? [...form.weekdays, i] : form.weekdays.filter((d) => d !== i))}
                        />
                        <span>{w}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="field field--short">
                  <span>何週ごと</span>
                  <select value={form.everyWeeks} onChange={(e) => set("everyWeeks", Number(e.target.value))}>
                    <option value={1}>毎週</option>
                    <option value={2}>隔週</option>
                    <option value={3}>3週ごと</option>
                    <option value={4}>4週ごと</option>
                  </select>
                </label>
              </>
            )}

            {form.kind === "monthly_nth_weekday" && (
              <div className="row-form">
                <label className="field field--short">
                  <span>第何週</span>
                  <select value={form.nth} onChange={(e) => set("nth", Number(e.target.value) as FormState["nth"])}>
                    {NTH.map((n) => (
                      <option key={n} value={n}>
                        {n === -1 ? "最終" : `第${n}`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field field--short">
                  <span>曜日</span>
                  <select value={form.weekday} onChange={(e) => set("weekday", Number(e.target.value))}>
                    {WEEKDAYS.map((w, i) => (
                      <option key={w} value={i}>
                        {w}曜
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {form.kind === "monthly_day" && (
              <label className="field field--short">
                <span>日付</span>
                <select value={form.day} onChange={(e) => set("day", Number(e.target.value))}>
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      {d}日{d >= 29 ? "（無い月は月末）" : ""}
                    </option>
                  ))}
                  <option value={-1}>月末</option>
                </select>
              </label>
            )}

            {form.kind !== "weekly" && (
              <label className="field field--short">
                <span>何か月ごと</span>
                <select value={form.everyMonths} onChange={(e) => set("everyMonths", Number(e.target.value))}>
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
                <input type="date" value={anchor} min={today} onChange={(e) => set("anchor", e.target.value)} required />
              </label>
            )}
          </div>
        )}

        <p className="preview" aria-live="polite">
          {schedule && preview?.dueOn ? (
            <>
              {schedule.type === "calendar" && <>{describeRule(schedule.rule)}。</>}
              次の期限は <b>{shortDate(preview.dueOn)}</b>
              {preview.status === "overdue" && <>（もう {preview.daysLate}日 過ぎています）</>}
            </>
          ) : form.type === "calendar" && form.kind === "weekly" && form.weekdays.length === 0 ? (
            "曜日を1つ以上選んでください"
          ) : (
            "この決め方では、予定日が見つかりません"
          )}
        </p>

        <div className="row-form">
          <label className="field field--short">
            <span>担当</span>
            <select value={form.assigneeUserId} onChange={(e) => set("assigneeUserId", e.target.value)}>
              <option value="">なし（通知は家族全員に）</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="field field--short">
            <span>通知の時刻</span>
            <select value={form.notifyTime} onChange={(e) => set("notifyTime", e.target.value)}>
              <option value="">それぞれの人の時刻</option>
              {TIMES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button className="btn btn--primary" type="submit" disabled={busy || !form.name.trim() || !schedule}>
            {editId ? "保存する" : "登録する"}
          </button>
          <button type="button" className="btn btn--quiet" onClick={() => nav.back(editId ? { name: "chore", id: editId } : { name: "chores" })}>
            やめる
          </button>
        </div>
      </form>
    </main>
  );
}
