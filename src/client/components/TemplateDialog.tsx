// 「よくある家事から選ぶ」の小さな画面。まとめて登録の1行ずつの画面と表の画面で使う
import { useEffect, useRef, useState } from "react";
import { describeRule } from "../../shared/describe";
import { CHORE_TEMPLATES, type ChoreTemplate } from "../../shared/templates";

export function useModal(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
  }, []);
  return { ref, onClose };
}

/** よくある家事から選ぶ。グループごとに並べ、もうある家事は最初から外しておく */
export function TemplateDialog({ existing, onAdd, onCancel }: { existing: string[]; onAdd: (t: ChoreTemplate[]) => void; onCancel: () => void }) {
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
