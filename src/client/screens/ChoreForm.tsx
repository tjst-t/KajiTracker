import { useEffect, useState } from "react";
import { todayInTokyo } from "../../shared/date";
import { describeRule, shortDate } from "../../shared/describe";
import { type Schedule, evaluate } from "../../shared/schedule";
import { type Family, type Group, type Member, api } from "../api";
import type { ChoreDetail, ChoreView } from "../chores";
import { type CalState, CalendarFields, anchorOfCal, calValid, initialCal, ruleForApi, ruleOfCal } from "../components/CalendarFields";
import { errorText } from "../format";
import type { Nav } from "../router";

export const TIMES = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`);

type FormState = {
  name: string;
  type: "interval" | "calendar";
  intervalDays: number;
  firstDueOn: string;
  cal: CalState;
  groupId: string;
  assigneeUserId: string;
  notifyTime: string;
};

function initial(today: string, chore?: ChoreView): FormState {
  return {
    name: chore?.name ?? "",
    type: chore?.schedule.type ?? "interval",
    intervalDays: chore?.schedule.type === "interval" ? chore.schedule.intervalDays : 7,
    firstDueOn: chore?.schedule.type === "interval" ? (chore.dueOn ?? chore.schedule.firstDueOn) : today,
    cal: initialCal(today, chore?.schedule.type === "calendar" ? chore.schedule.rule : undefined),
    groupId: chore?.groupId ?? "",
    assigneeUserId: chore?.assigneeUserId ?? "",
    notifyTime: chore?.notifyTime ?? "",
  };
}

/** S3 家事の登録・編集（主に PC で使う） */
export function ChoreForm({ family, nav, editId }: { family: Family; nav: Nav; editId?: string }) {
  const today = todayInTokyo();
  const [form, setForm] = useState<FormState | null>(editId ? null : initial(today));
  const [members, setMembers] = useState<Member[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  useEffect(() => {
    api<Member[]>("GET", `/families/${family.id}/members`)
      .then(setMembers)
      .catch(() => {});
    api<Group[]>("GET", `/families/${family.id}/groups`)
      .then(setGroups)
      .catch(() => {});
    if (editId)
      api<ChoreDetail>("GET", `/chores/${editId}`)
        // 入力を始めたあとに遅れて届いた読み込みで、書いた内容を上書きしない
        .then((c) => setForm((f) => f ?? initial(today, c)))
        .catch((e) => setError(errorText(e)));
  }, [family.id, editId, today]);

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

  const schedule: Schedule | null =
    form.type === "interval"
      ? { type: "interval", intervalDays: form.intervalDays, firstDueOn: form.firstDueOn }
      : calValid(form.cal)
        ? { type: "calendar", rule: ruleOfCal(form.cal, anchorOfCal(form.cal, today)) }
        : null;
  const preview = schedule ? evaluate(schedule, [], today) : null;

  const submit = async () => {
    if (!schedule) return;
    setBusy(true);
    setError(null);
    const payload = {
      name: form.name,
      schedule: schedule.type === "interval" ? schedule : { type: "calendar", rule: ruleForApi(form.cal, today) },
      groupId: form.groupId || null,
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
      {!editId && (
        <p className="muted">
          いくつも登録するなら、
          <a
            href="/chores/bulk"
            onClick={(e) => {
              e.preventDefault();
              nav.go({ name: "chore-bulk" });
            }}
          >
            表でまとめて登録
          </a>
          するほうが早いです。
        </p>
      )}
      <form
        className="chore-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="row-form">
          <label className="field">
            <span>家事の名前</span>
            <input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={40} required placeholder="例：ゴミ出し、エアコンのフィルター" autoFocus={!editId} />
          </label>
          <label className="field field--short">
            <span>グループ</span>
            <select value={form.groupId} onChange={(e) => set("groupId", e.target.value)}>
              <option value="">なし</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
        </div>

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
          <CalendarFields value={form.cal} onChange={(cal) => set("cal", cal)} today={today} />
        )}

        <p className="preview" aria-live="polite">
          {schedule && preview?.dueOn ? (
            <>
              {schedule.type === "calendar" && <>{describeRule(schedule.rule)}。</>}
              次の期限は <b>{shortDate(preview.dueOn)}</b>
              {preview.status === "overdue" && <>（もう {preview.daysLate}日 過ぎています）</>}
            </>
          ) : !calValid(form.cal) && form.type === "calendar" ? (
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
