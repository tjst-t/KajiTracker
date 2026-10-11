import { useCallback, useEffect, useRef, useState } from "react";
import { shortDate } from "../../shared/describe";
import { type Family, type Group, type Member, api } from "../api";
import { Hanko } from "../components/Fuda";
import { HOWTO_MAX, HowtoEditor, howtoLength } from "../components/Howto";
import { Progress, useAskDone } from "../components/TodoParts";
import { errorText } from "../format";
import { type Nav, setLeaveGuard } from "../router";
import { type SubtaskView, type TodoDetail as Detail, completeTodo, dateOfIso, dueOf } from "../todos";
import { TIMES } from "./ChoreForm";

type FormState = { title: string; memo: string; dueOn: string; assigneeUserId: string; groupId: string; notifyTime: string };

const formOf = (t: Detail): FormState => ({
  title: t.title,
  memo: t.memo ?? "",
  dueOn: t.dueOn ?? "",
  assigneeUserId: t.assigneeUserId ?? "",
  groupId: t.groupId ?? "",
  notifyTime: t.notifyTime ?? "",
});

const same = (a: FormState, b: FormState) => (Object.keys(a) as (keyof FormState)[]).every((k) => a[k] === b[k]);

/** TODO の詳細：題名・メモ（Markdown）・期限・担当・グループ・通知の時刻を直す。サブタスク（1段）、済み・取り消し・消す */
export function TodoDetail({ id, family, nav }: { id: string; family: Family; nav: Nav }) {
  const [todo, setTodo] = useState<Detail | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const { ask, dialog } = useAskDone();
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const load = useCallback(async () => {
    const t = await api<Detail>("GET", `/todos/${id}`);
    setTodo(t);
    // 書きかけの内容は、読み直しで上書きしない
    setForm((f) => f ?? formOf(t));
    return t;
  }, [id]);

  useEffect(() => {
    load().catch((e) => setMessage({ kind: "error", text: errorText(e) }));
    api<Member[]>("GET", `/families/${family.id}/members`)
      .then(setMembers)
      .catch(() => {});
    api<Group[]>("GET", `/families/${family.id}/groups`)
      .then(setGroups)
      .catch(() => {});
  }, [load, family.id]);

  const dirty = !!todo && !!form && !same(form, formOf(todo));
  useEffect(() => {
    setLeaveGuard(dirty ? "保存していない変更があります。このまま離れますか？" : null);
    return () => setLeaveGuard(null);
  }, [dirty]);

  /** うまくいけば true */
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      await load();
      if (done) setMessage({ kind: "ok", text: done });
      return true;
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!todo || !form)
    return (
      <main className="page">
        {message ? (
          <p className="error" role="alert">
            {message.text}
          </p>
        ) : (
          <p aria-busy="true">読み込んでいます…</p>
        )}
      </main>
    );

  const save = () =>
    run(async () => {
      const t = await api<Detail>("PATCH", `/todos/${todo.id}`, {
        title: form.title,
        memo: form.memo,
        dueOn: form.dueOn || null,
        assigneeUserId: form.assigneeUserId || null,
        groupId: form.groupId || null,
        notifyTime: form.notifyTime || null,
      });
      setForm(formOf({ ...t, today: todo.today }));
    }, "保存しました");

  const toggleDone = async () => {
    if (todo.done) return run(() => api("PATCH", `/todos/${todo.id}`, { done: false }), "未完了に戻しました");
    const all = await ask(todo);
    if (all === null) return;
    return run(() => completeTodo(todo, all), "済みにしました");
  };

  return (
    <main className="page page--wide todo-detail">
      <p className="crumb">
        <a
          href="/todos"
          onClick={(e) => {
            e.preventDefault();
            nav.go({ name: "todos" });
          }}
        >
          TODO
        </a>
      </p>
      <div className="detail-head">
        <div>
          <h1>{todo.title}</h1>
          <p className="detail-sub">
            {todo.done && todo.doneAt
              ? `${shortDate(dateOfIso(todo.doneAt))} ${todo.doneByName ?? ""}に済み`
              : todo.dueOn
                ? `期限 ${shortDate(todo.dueOn)}`
                : "期限なし"}
            {todo.createdByName && `、${todo.createdByName}が作成`}
          </p>
        </div>
        {!todo.done && <Hanko chore={dueOf(todo)} today={todo.today} />}
      </div>

      {message && (
        <p className={message.kind === "ok" ? "notice notice--ok" : "error"} role={message.kind === "ok" ? "status" : "alert"}>
          {message.text}
        </p>
      )}

      <form
        className="chore-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="field todo-detail__title">
          <span>題名</span>
          <input value={form.title} onChange={(e) => set("title", e.target.value)} maxLength={60} required />
        </label>
        <div className="row-form">
          <label className="field field--short">
            <span>期限</span>
            <input type="date" value={form.dueOn} onChange={(e) => set("dueOn", e.target.value)} />
          </label>
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
          <label className="field field--short">
            <span>通知の時刻（期限の日）</span>
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
        <HowtoEditor
          value={form.memo}
          onChange={(v) => set("memo", v)}
          label="メモ"
          placeholder={"例：\n- 窓口は平日 9〜17時\n- 持ち物：**印鑑**・本人確認書類\n- [電話番号の載っているページ](https://…)"}
          initialMode={todo.memo ? "view" : "write"}
        />
        <div className="form-actions">
          <button className="btn btn--primary" type="submit" disabled={busy || !dirty || !form.title.trim() || howtoLength(form.memo) > HOWTO_MAX}>
            保存する
          </button>
          {dirty && (
            <button type="button" className="btn btn--quiet" onClick={() => setForm(formOf(todo))}>
              変更をやめる
            </button>
          )}
        </div>
      </form>

      <Subtasks todoId={todo.id} subtasks={todo.subtasks} progress={todo.progress} busy={busy} run={run} />

      <section className="section">
        <div className="form-actions">
          <button className={todo.done ? "btn" : "btn btn--primary"} disabled={busy} onClick={() => void toggleDone()}>
            {todo.done ? "未完了に戻す" : "済みにする"}
          </button>
          <button
            className="btn btn--danger-quiet"
            disabled={busy}
            onClick={async () => {
              if (!confirm(`「${todo.title}」を消しますか？ サブタスクも消え、元に戻せません。`)) return;
              try {
                await api("DELETE", `/todos/${todo.id}`);
                setLeaveGuard(null);
                nav.go({ name: "todos" });
              } catch (e) {
                setMessage({ kind: "error", text: errorText(e) });
              }
            }}
          >
            消す
          </button>
        </div>
      </section>
      {dialog}
    </main>
  );
}

/** サブタスクの一覧：チェック・題名をその場で直す・上へ／下へ・消す。下の1行で Enter を押すと続けて足せる */
function Subtasks({
  todoId,
  subtasks,
  progress,
  busy,
  run,
}: {
  todoId: string;
  subtasks: SubtaskView[];
  progress: { done: number; total: number };
  busy: boolean;
  run: (fn: () => Promise<unknown>, done?: string) => Promise<boolean>;
}) {
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [newTitle, setNewTitle] = useState("");
  const addRef = useRef<HTMLInputElement>(null);

  const rename = (s: SubtaskView) => {
    const v = (titles[s.id] ?? s.title).trim();
    if (!v || v === s.title) return setTitles(({ [s.id]: _, ...rest }) => rest);
    void run(async () => {
      await api("PATCH", `/subtasks/${s.id}`, { title: v });
      setTitles(({ [s.id]: _, ...rest }) => rest);
    });
  };

  /** 隣と入れ替える（並び順をつけ直す） */
  const move = (i: number, dir: -1 | 1) => {
    const order = subtasks.map((s) => s.id);
    const j = i + dir;
    [order[i], order[j]] = [order[j]!, order[i]!];
    void run(() => Promise.all(order.map((id, k) => api("PATCH", `/subtasks/${id}`, { sortOrder: k }))));
  };

  return (
    <section className="section" aria-labelledby="d-subtasks">
      <h2 id="d-subtasks" className="subtasks__head">
        サブタスク
        <Progress {...progress} />
      </h2>
      {subtasks.length > 0 && (
        <ul className="subtasks" aria-label="サブタスクの一覧">
          {subtasks.map((s, i) => (
            <li key={s.id} className={`subtask${s.done ? " is-done" : ""}`}>
              <button
                className="todo-row__check"
                aria-pressed={s.done}
                aria-label={s.done ? `「${s.title}」を未完了に戻す` : `「${s.title}」を済みにする`}
                disabled={busy}
                onClick={() => void run(() => api("PATCH", `/subtasks/${s.id}`, { done: !s.done }))}
              >
                <span className="memo__check" aria-hidden="true" />
              </button>
              <input
                className="subtask__title"
                value={titles[s.id] ?? s.title}
                maxLength={60}
                aria-label={`サブタスク「${s.title}」の題名`}
                onChange={(e) => setTitles({ ...titles, [s.id]: e.target.value })}
                onBlur={() => rename(s)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                }}
              />
              <div className="subtask__actions">
                <button className="btn btn--small" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={`${s.title}を上へ`}>
                  上へ
                </button>
                <button className="btn btn--small" disabled={busy || i === subtasks.length - 1} onClick={() => move(i, 1)} aria-label={`${s.title}を下へ`}>
                  下へ
                </button>
                <button className="memo__remove" disabled={busy} onClick={() => void run(() => api("DELETE", `/subtasks/${s.id}`))} aria-label={`サブタスク「${s.title}」を消す`}>
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="quick-add"
        onSubmit={(e) => {
          e.preventDefault();
          const t = newTitle.trim();
          if (!t) return;
          void run(() => api("POST", `/todos/${todoId}/subtasks`, { title: t })).then((ok) => {
            if (ok) setNewTitle("");
            addRef.current?.focus();
          });
        }}
      >
        <label className="visually-hidden" htmlFor="subtask-add">
          サブタスクを足す
        </label>
        <input
          id="subtask-add"
          ref={addRef}
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          maxLength={60}
          placeholder="サブタスクを足す（Enter で続けて足せます）"
          autoComplete="off"
          enterKeyHint="next"
        />
        <button className="btn" type="submit" disabled={busy || !newTitle.trim()}>
          足す
        </button>
      </form>
    </section>
  );
}
