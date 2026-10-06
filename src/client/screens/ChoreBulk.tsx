import { Fragment, useEffect, useRef, useState } from "react";
import { addDays, todayInTokyo } from "../../shared/date";
import { describeRule, shortDate } from "../../shared/describe";
import { evaluate } from "../../shared/schedule";
import { CHORE_TEMPLATES, type ChoreTemplate } from "../../shared/templates";
import { ApiError, type Family, type Group, type Member, api } from "../api";
import type { ChoreView } from "../chores";
import { type CalState, CalendarFields, anchorOfCal, calValid, initialCal, ruleForApi, ruleOfCal } from "../components/CalendarFields";
import { errorText } from "../format";
import type { Nav } from "../router";

type Row = {
  key: number;
  name: string;
  groupId: string;
  type: "interval" | "calendar";
  intervalDays: string;
  firstDueOn: string;
  cal: CalState;
  assigneeUserId: string;
};

let seq = 0;
const blankRow = (today: string, patch: Partial<Row> = {}): Row => ({
  key: ++seq,
  name: "",
  groupId: "",
  type: "interval",
  intervalDays: "7",
  firstDueOn: today,
  cal: initialCal(today),
  assigneeUserId: "",
  ...patch,
});
const isBlank = (r: Row) => !r.name.trim();

/** 表でまとめて登録。1行が1つの家事。名前が空の行は登録しない */
export function ChoreBulk({ family, nav }: { family: Family; nav: Nav }) {
  const today = todayInTokyo();
  const [rows, setRows] = useState<Row[]>(() => [blankRow(today), blankRow(today), blankRow(today)]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [existing, setExisting] = useState<string[]>([]);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [editingCal, setEditingCal] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Group[]>("GET", `/families/${family.id}/groups`).then(setGroups).catch(() => {});
    api<Member[]>("GET", `/families/${family.id}/members`).then(setMembers).catch(() => {});
    api<{ chores: ChoreView[] }>("GET", `/families/${family.id}/chores?archived=1`)
      .then((d) => setExisting(d.chores.map((c) => c.name)))
      .catch(() => {});
  }, [family.id]);

  const update = (key: number, patch: Partial<Row>) => {
    setRows((rs) => {
      const next = rs.map((r) => (r.key === key ? { ...r, ...patch } : r));
      // 最後の行に名前を入れ始めたら、空の行を1つ足す（表に書き足していく感覚で）
      const last = next[next.length - 1]!;
      return last.key === key && !isBlank(last) ? [...next, blankRow(today)] : next;
    });
    setRowErrors(({ [key]: _, ...rest }) => rest);
  };
  const remove = (key: number) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : [blankRow(today)]));

  const addTemplates = (picked: ChoreTemplate[]) => {
    const groupByName = Object.fromEntries(groups.map((g) => [g.name, g.id]));
    const added = picked.map((t) =>
      blankRow(today, {
        name: t.name,
        groupId: groupByName[t.group] ?? "",
        ...(t.schedule.type === "interval"
          ? // 前にやった日は分からないので、今日から1周期あとを最初の期限にしておく
            { type: "interval" as const, intervalDays: String(t.schedule.intervalDays), firstDueOn: addDays(today, t.schedule.intervalDays) }
          : { type: "calendar" as const, cal: { ...initialCal(today), kind: "weekly" as const, weekdays: t.schedule.weekdays } }),
      }),
    );
    setRows((rs) => [...rs.filter((r) => !isBlank(r)), ...added, blankRow(today)]);
    setPicking(false);
  };

  const filled = rows.filter((r) => !isBlank(r));

  const submit = async () => {
    setBusy(true);
    setError(null);
    setRowErrors({});
    const payload = filled.map((r) => ({
      name: r.name,
      groupId: r.groupId || null,
      assigneeUserId: r.assigneeUserId || null,
      schedule:
        r.type === "interval"
          ? { type: "interval", intervalDays: Number(r.intervalDays), firstDueOn: r.firstDueOn }
          : { type: "calendar", rule: ruleForApi(r.cal, today) },
    }));
    try {
      const res = await api<{ created: number }>("POST", `/families/${family.id}/chores/bulk`, { chores: payload });
      sessionStorage.setItem("kaji.flash", `${res.created}件の家事を登録しました`);
      nav.go({ name: "chores" });
    } catch (e) {
      if (e instanceof ApiError && e.code === "bulk_invalid" && e.detail?.rows) {
        const map: Record<number, string> = {};
        for (const { index, message } of e.detail.rows as { index: number; message: string }[]) map[filled[index]!.key] = message;
        setRowErrors(map);
      }
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const editingRow = rows.find((r) => r.key === editingCal);

  return (
    <main className="page page--wide">
      <div className="page-head">
        <h1>まとめて登録</h1>
        <button className="btn" onClick={() => setPicking(true)}>
          よくある家事から選ぶ
        </button>
      </div>
      <p className="muted">1行に1つの家事を書きます。名前が空の行は登録しません。最初の期限は、前にやった日が分かればその日に周期を足した日にしてください。</p>

      <div className="bulk-scroll">
        <table className="bulk-table">
          <thead>
            <tr>
              <th scope="col">家事の名前</th>
              <th scope="col">グループ</th>
              <th scope="col">周期</th>
              <th scope="col">最初の期限</th>
              <th scope="col">担当</th>
              <th scope="col">
                <span className="visually-hidden">行の操作</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const err = rowErrors[r.key];
              const label = `${i + 1}行目`;
              const calDue = r.type === "calendar" && calValid(r.cal) ? evaluate({ type: "calendar", rule: ruleOfCal(r.cal, anchorOfCal(r.cal, today)) }, [], today).dueOn : null;
              return (
                <Fragment key={r.key}>
                  <tr className={err ? "has-error" : isBlank(r) ? "is-blank" : ""}>
                    <td>
                      <input value={r.name} onChange={(e) => update(r.key, { name: e.target.value })} maxLength={40} placeholder="例：シンクの排水口" aria-label={`${label}の家事の名前`} />
                    </td>
                    <td>
                      <select value={r.groupId} onChange={(e) => update(r.key, { groupId: e.target.value })} aria-label={`${label}のグループ`}>
                        <option value="">なし</option>
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      {r.type === "interval" ? (
                        <div className="cycle-cell">
                          <input
                            type="number"
                            min={1}
                            max={3660}
                            value={r.intervalDays}
                            onChange={(e) => update(r.key, { intervalDays: e.target.value })}
                            aria-label={`${label}の何日ごと`}
                          />
                          <span>日ごと</span>
                          <button type="button" className="btn btn--small" onClick={() => setEditingCal(r.key)} aria-label={`${label}を曜日・日付で決める`}>
                            曜日・日付で
                          </button>
                        </div>
                      ) : (
                        <div className="cycle-cell">
                          <button type="button" className="btn btn--small cycle-rule" onClick={() => setEditingCal(r.key)} aria-label={`${label}の周期を変える`}>
                            {calValid(r.cal) ? describeRule(ruleOfCal(r.cal, today)) : "曜日を選ぶ"}
                          </button>
                          <button type="button" className="btn btn--quiet btn--small" onClick={() => update(r.key, { type: "interval" })}>
                            日数にする
                          </button>
                        </div>
                      )}
                    </td>
                    <td>
                      {r.type === "interval" ? (
                        <input type="date" value={r.firstDueOn} onChange={(e) => update(r.key, { firstDueOn: e.target.value })} aria-label={`${label}の最初の期限`} />
                      ) : (
                        <span className="muted">{calDue ? shortDate(calDue) : "—"}</span>
                      )}
                    </td>
                    <td>
                      <select value={r.assigneeUserId} onChange={(e) => update(r.key, { assigneeUserId: e.target.value })} aria-label={`${label}の担当`}>
                        <option value="">なし</option>
                        {members.map((m) => (
                          <option key={m.userId} value={m.userId}>
                            {m.displayName}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button type="button" className="btn btn--danger-quiet" onClick={() => remove(r.key)} aria-label={`${label}を消す`}>
                        消す
                      </button>
                    </td>
                  </tr>
                  {(err || (!isBlank(r) && existing.includes(r.name.trim()))) && (
                    <tr className="row-note">
                      <td colSpan={6}>{err ? <span className="error">{err}</span> : <span className="muted">同じ名前の家事が、もうあります</span>}</td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions bulk-actions">
        <button className="btn btn--primary" disabled={busy || filled.length === 0} onClick={() => void submit()}>
          {filled.length > 0 ? `${filled.length}件を登録` : "登録する家事がありません"}
        </button>
        <button className="btn" onClick={() => setRows((rs) => [...rs, blankRow(today)])}>
          行を足す
        </button>
        <button className="btn btn--quiet" onClick={() => nav.back({ name: "chores" })}>
          やめる
        </button>
      </div>

      {editingRow && (
        <CalendarDialog
          initial={editingRow.cal}
          today={today}
          onCancel={() => setEditingCal(null)}
          onSave={(cal) => {
            update(editingRow.key, { type: "calendar", cal });
            setEditingCal(null);
          }}
        />
      )}
      {picking && <TemplateDialog existing={[...existing, ...filled.map((r) => r.name.trim())]} onCancel={() => setPicking(false)} onAdd={addTemplates} />}
    </main>
  );
}

function useModal(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
  }, []);
  return { ref, onClose };
}

/** 曜日・日付で決める小さな画面 */
function CalendarDialog({ initial, today, onSave, onCancel }: { initial: CalState; today: string; onSave: (c: CalState) => void; onCancel: () => void }) {
  const [cal, setCal] = useState(initial);
  const { ref } = useModal(onCancel);
  return (
    <dialog ref={ref} className="dialog" onClose={onCancel} aria-labelledby="cal-dialog-title">
      <h2 id="cal-dialog-title">曜日・日付で決める</h2>
      <CalendarFields value={cal} onChange={setCal} today={today} idPrefix="bulk-cal" />
      <p className="preview">{calValid(cal) ? describeRule(ruleOfCal(cal, today)) : "曜日を1つ以上選んでください"}</p>
      <div className="form-actions">
        <button className="btn btn--primary" disabled={!calValid(cal)} onClick={() => onSave(cal)}>
          決める
        </button>
        <button className="btn btn--quiet" onClick={() => ref.current?.close()}>
          やめる
        </button>
      </div>
    </dialog>
  );
}

/** よくある家事から選ぶ。グループごとに並べ、もうある家事は最初から外しておく */
function TemplateDialog({ existing, onAdd, onCancel }: { existing: string[]; onAdd: (t: ChoreTemplate[]) => void; onCancel: () => void }) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set(CHORE_TEMPLATES.filter((t) => !existing.includes(t.name)).map((t) => t.name)));
  const { ref } = useModal(onCancel);
  const byGroup = [...new Set(CHORE_TEMPLATES.map((t) => t.group))].map((g) => ({ group: g, items: CHORE_TEMPLATES.filter((t) => t.group === g) }));
  const toggle = (name: string, on: boolean) => setChecked((s) => (on ? new Set(s).add(name) : new Set([...s].filter((n) => n !== name))));
  const scheduleText = (t: ChoreTemplate) =>
    t.schedule.type === "interval" ? `${t.schedule.intervalDays}日ごと` : describeRule({ kind: "weekly", weekdays: t.schedule.weekdays, every: 1, anchor: "2026-01-01" });

  return (
    <dialog ref={ref} className="dialog dialog--wide" onClose={onCancel} aria-labelledby="tpl-dialog-title">
      <h2 id="tpl-dialog-title">よくある家事から選ぶ</h2>
      <p className="muted">選んだ家事を表に足します。周期や期限は、表で直せます。</p>
      <div className="templates">
        {byGroup.map(({ group, items }) => (
          <fieldset key={group} className="fieldset">
            <legend>{group}</legend>
            {items.map((t) => {
              const have = existing.includes(t.name);
              return (
                <label key={t.name} className="check template">
                  <input type="checkbox" checked={checked.has(t.name)} onChange={(e) => toggle(t.name, e.target.checked)} />
                  <span>
                    {t.name}
                    <span className="muted">
                      {" "}
                      {scheduleText(t)}
                      {have && "（もうあります）"}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        ))}
      </div>
      <div className="form-actions">
        <button className="btn btn--primary" disabled={checked.size === 0} onClick={() => onAdd(CHORE_TEMPLATES.filter((t) => checked.has(t.name)))}>
          {checked.size}件を表に足す
        </button>
        <button className="btn btn--quiet" onClick={() => ref.current?.close()}>
          やめる
        </button>
      </div>
    </dialog>
  );
}
