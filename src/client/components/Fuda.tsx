import type { ReactNode } from "react";
import { diffDays } from "../../shared/date";
import { shortDate } from "../../shared/describe";
import type { ChoreView, LogView } from "../chores";
import { type TodoView, dateOfIso, dueOf } from "../todos";
import { Progress } from "./TodoParts";

/** 期限から見た状態（家事は status、TODO は dueStatus を status に入れて渡す） */
type Due = { status: string | null; daysLate: number; dueOn: string | null };

/** 期限の印。遅れは朱の判子、今日は藍の判子 */
export function Hanko({ chore, today }: { chore: Due; today: string }) {
  if (chore.status === "overdue")
    return (
      <span className="hanko hanko--late" aria-label={`${chore.daysLate}日遅れ`}>
        <b>{chore.daysLate}日</b>
        <span>遅れ</span>
      </span>
    );
  if (chore.status === "today")
    return (
      <span className="hanko hanko--today" aria-label="今日まで">
        <b>今日</b>
      </span>
    );
  if (chore.dueOn) return <span className="due-soon">あと{diffDays(today, chore.dueOn)}日</span>;
  return null;
}

export function lastText(log: LogView | null): string {
  return log ? `前回 ${shortDate(log.doneOn)} ${log.userName}` : "まだ記録がありません";
}

/**
 * 当番札。表に家事と期限、「やった」を押すと裏返って「済」と取り消しを見せる。
 * 札の裏表は aria-hidden で切り替え、読み上げではいま見えている面だけを読む。
 */
export function Fuda(props: {
  chore: ChoreView;
  today: string;
  done: LogView | null;
  busy: boolean;
  onOpen: () => void;
  onDone: () => void;
  onUndo: () => void;
  /** やり方を開く（やり方のある家事だけ） */
  onHowto?: () => void;
}) {
  const { chore, done } = props;
  const meta: ReactNode[] = [];
  if (chore.assigneeName) meta.push(<span key="a">担当 {chore.assigneeName}</span>);
  meta.push(<span key="l">{lastText(chore.lastLog)}</span>);

  return (
    <li className={`fuda-wrap${done ? " is-done" : ""}`}>
      <div className="fuda-inner">
        <article className={`fuda fuda--${chore.status}`} aria-hidden={!!done}>
          <div className="fuda__body">
            {chore.groupName && <p className="fuda__group">{chore.groupName}</p>}
            <h3 className="fuda__name">
              <a
                href={`/chores/${chore.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  props.onOpen();
                }}
                tabIndex={done ? -1 : 0}
              >
                {chore.name}
              </a>
            </h3>
            <p className="fuda__meta">
              {meta.reduce<ReactNode[]>((acc, m, i) => (i ? [...acc, "、", m] : [m]), [])}
              {props.onHowto && (
                // 札の大きさは変えない：メタの行の終わりに小さく置く
                <button type="button" className="fuda__howto" onClick={props.onHowto} tabIndex={done ? -1 : 0} aria-label={`${chore.name}のやり方`}>
                  やり方
                </button>
              )}
            </p>
          </div>
          <Hanko chore={chore} today={props.today} />
          <button className="btn btn--primary fuda__done" onClick={props.onDone} disabled={props.busy || !!done} tabIndex={done ? -1 : 0}>
            やった
          </button>
        </article>
        <article className="fuda fuda--back" aria-hidden={!done} aria-live="polite">
          {done && (
            <>
              <span className="hanko hanko--done" aria-hidden="true">
                <b>済</b>
              </span>
              <div className="fuda__body">
                <p className="fuda__name">{chore.name}</p>
                <p className="fuda__meta">
                  {shortDate(done.doneOn)} {done.userName}
                </p>
              </div>
              <button className="btn fuda__undo" onClick={props.onUndo} disabled={props.busy}>
                取り消す
              </button>
            </>
          )}
        </article>
      </div>
    </li>
  );
}

/**
 * TODO の札。家事の札と同じ形で、左上に「TODO」の印、メタにサブタスクの進み具合。
 * 「済み」で裏返り、少しのあいだ取り消せる
 */
export function TodoFuda(props: {
  todo: TodoView;
  today: string;
  /** 済みにした直後（裏返っているあいだ）の中身 */
  done: TodoView | null;
  busy: boolean;
  onOpen: () => void;
  onDone: () => void;
  onUndo: () => void;
}) {
  const { todo, done } = props;
  const meta: ReactNode[] = [];
  if (todo.assigneeName) meta.push(<span key="a">担当 {todo.assigneeName}</span>);
  if (todo.hasMemo) meta.push(<span key="m">メモあり</span>);

  return (
    <li className={`fuda-wrap fuda-wrap--todo${done ? " is-done" : ""}`}>
      <div className="fuda-inner">
        <article className={`fuda fuda--todo fuda--${todo.dueStatus ?? "none"}`} aria-hidden={!!done}>
          <span className="fuda__kind">TODO</span>
          <div className="fuda__body">
            {todo.groupName && <p className="fuda__group">{todo.groupName}</p>}
            <h3 className="fuda__name">
              <a
                href={`/todos/${todo.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  props.onOpen();
                }}
                tabIndex={done ? -1 : 0}
              >
                {todo.title}
              </a>
            </h3>
            {(meta.length > 0 || todo.progress.total > 0) && (
              <p className="fuda__meta">
                <Progress {...todo.progress} />
                {meta.reduce<ReactNode[]>((acc, m, i) => (i ? [...acc, "、", m] : [m]), [])}
              </p>
            )}
          </div>
          <Hanko chore={dueOf(todo)} today={props.today} />
          <button className="btn btn--primary fuda__done" onClick={props.onDone} disabled={props.busy || !!done} tabIndex={done ? -1 : 0}>
            済み
          </button>
        </article>
        <article className="fuda fuda--back" aria-hidden={!done} aria-live="polite">
          {done && (
            <>
              <span className="hanko hanko--done" aria-hidden="true">
                <b>済</b>
              </span>
              <div className="fuda__body">
                <p className="fuda__name">{todo.title}</p>
                <p className="fuda__meta">
                  {done.doneAt ? shortDate(dateOfIso(done.doneAt)) : ""} {done.doneByName ?? ""}
                </p>
              </div>
              <button className="btn fuda__undo" onClick={props.onUndo} disabled={props.busy}>
                取り消す
              </button>
            </>
          )}
        </article>
      </div>
    </li>
  );
}
