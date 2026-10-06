import type { ReactNode } from "react";
import { diffDays } from "../../shared/date";
import { shortDate } from "../../shared/describe";
import type { ChoreView, LogView } from "../chores";

/** 期限の印。遅れは朱の判子、今日は藍の判子 */
export function Hanko({ chore, today }: { chore: ChoreView; today: string }) {
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
            <p className="fuda__meta">{meta.reduce<ReactNode[]>((acc, m, i) => (i ? [...acc, "、", m] : [m]), [])}</p>
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
