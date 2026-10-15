import { useCallback, useEffect, useRef, useState } from "react";
import { shortDate } from "../../shared/describe";
import { type Family, type Group, api } from "../api";
import { buzz } from "../celebrate";
import { DoneStamp, Hanko } from "../components/Fuda";
import { Progress, useAskDone } from "../components/TodoParts";
import { errorText } from "../format";
import type { Nav } from "../router";
import { type Completed, type TodoView, completeTodo, dateOfIso, dueOf, undoComplete } from "../todos";

const UNDO_MS = 6000;
const NONE = "__none__";

type Data = { today: string; todos: TodoView[] };

/** TODO の一覧。「未完了」（期限の近い順）と「済み」を切り替え、グループで絞れる。上の1行で題名だけですばやく足す */
export function Todos({ family, nav }: { family: Family; nav: Nav }) {
  const [status, setStatus] = useState<"open" | "done">("open");
  const [data, setData] = useState<Data | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [filter, setFilter] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 済みにした直後（数秒「取り消す」を出す） */
  const [completed, setCompleted] = useState<Completed | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { ask, dialog } = useAskDone();

  const load = useCallback(async () => {
    try {
      setData(await api<Data>("GET", `/families/${family.id}/todos?status=${status}`));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [family.id, status]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  useEffect(() => {
    api<Group[]>("GET", `/families/${family.id}/groups`)
      .then(setGroups)
      .catch(() => {});
  }, [family.id]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const add = (t: string) =>
    run("add", async () => {
      await api("POST", `/families/${family.id}/todos`, { title: t, groupId: filter && filter !== NONE ? filter : null });
      setTitle("");
    });

  const toggle = async (todo: TodoView) => {
    if (todo.done) return run(todo.id, () => api("PATCH", `/todos/${todo.id}`, { done: false }));
    const all = await ask(todo);
    if (all === null) return;
    await run(todo.id, async () => {
      const c = await completeTodo(todo, all);
      clearTimeout(timer.current);
      setCompleted(c);
      buzz(12);
      timer.current = setTimeout(() => setCompleted(null), UNDO_MS);
    });
  };

  const undo = (c: Completed) =>
    run(c.todo.id, async () => {
      clearTimeout(timer.current);
      setCompleted(null);
      await undoComplete(c);
    });

  const shown = (data?.todos ?? []).filter((t) => !filter || (t.groupId ?? NONE) === filter);

  return (
    <main className="page todos">
      <div className="page-head">
        <h1>TODO</h1>
        <div className="segmented" role="tablist" aria-label="TODO の表示">
          {(["open", "done"] as const).map((s) => (
            <button key={s} role="tab" aria-selected={status === s} onClick={() => setStatus(s)}>
              {s === "open" ? "未完了" : "済み"}
            </button>
          ))}
        </div>
      </div>

      {status === "open" && (
        <form
          className="quick-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) void add(title.trim());
          }}
        >
          <label className="visually-hidden" htmlFor="todo-quick">
            TODO を足す
          </label>
          <input
            id="todo-quick"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={60}
            placeholder="TODO を足す（題名だけで Enter）"
            autoComplete="off"
            enterKeyHint="done"
          />
          <button className="btn btn--primary" type="submit" disabled={busy === "add" || !title.trim()}>
            足す
          </button>
        </form>
      )}

      {groups.length > 0 && (
        <div className="filters">
          <label className="field field--short">
            <span>グループで絞る</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">すべて</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
              <option value={NONE}>グループなし</option>
            </select>
          </label>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {!data ? (
        !error && <p aria-busy="true">読み込んでいます…</p>
      ) : shown.length === 0 ? (
        <p className="shop-empty">
          {status === "done" ? "済んだ TODO はまだありません。" : filter ? "このグループの TODO はありません。" : "TODO はありません。上の欄に題名を入れて Enter で足せます。"}
        </p>
      ) : (
        <ul className="todo-list" aria-label={status === "open" ? "未完了の TODO" : "済んだ TODO"}>
          {shown.map((t) => (
            <TodoRow key={t.id} todo={t} today={data.today} busy={busy === t.id} onToggle={() => void toggle(t)} onOpen={() => nav.go({ name: "todo", id: t.id })} />
          ))}
        </ul>
      )}

      {completed && (
        <div className="undo-bar" role="status">
          <DoneStamp key={completed.todo.id} />
          <p>「{completed.todo.title}」を済みにしました</p>
          <button className="btn btn--small" onClick={() => void undo(completed)} disabled={busy === completed.todo.id}>
            取り消す
          </button>
        </div>
      )}
      {dialog}
    </main>
  );
}

/** 一覧の1行：左にチェック、題名・期限の判子・担当・グループ・サブタスクの進み具合 */
function TodoRow({ todo: t, today, busy, onToggle, onOpen }: { todo: TodoView; today: string; busy: boolean; onToggle: () => void; onOpen: () => void }) {
  const meta = [t.assigneeName && `担当 ${t.assigneeName}`, t.groupName, t.done && t.doneAt && `${shortDate(dateOfIso(t.doneAt))} ${t.doneByName ?? ""}に済み`].filter(Boolean);
  return (
    <li className={`todo-row${t.done ? " is-done" : ""}${t.dueStatus === "overdue" ? " is-late" : ""}`}>
      <button className="todo-row__check" aria-pressed={t.done} aria-label={t.done ? `「${t.title}」を未完了に戻す` : `「${t.title}」を済みにする`} onClick={onToggle} disabled={busy}>
        <span className="memo__check" aria-hidden="true" />
      </button>
      <div className="todo-row__body">
        <p className="todo-row__title">
          <a
            href={`/todos/${t.id}`}
            onClick={(e) => {
              e.preventDefault();
              onOpen();
            }}
          >
            {t.title}
          </a>
        </p>
        <p className="todo-row__meta">
          {!t.done && t.dueOn && t.dueStatus === "upcoming" && <span>{shortDate(t.dueOn)}まで</span>}
          {meta.map((m) => (
            <span key={m as string}>{m}</span>
          ))}
          {t.hasMemo && <span>メモあり</span>}
          <Progress {...t.progress} />
        </p>
      </div>
      {!t.done && (t.dueStatus === "overdue" || t.dueStatus === "today") && (
        <span className="due-cell">
          <Hanko chore={dueOf(t)} today={today} />
        </span>
      )}
    </li>
  );
}
