// TODO の一覧・詳細・今日の札で使う小さな部品：サブタスクの進み具合、済みにするときの確かめ
import { type ReactNode, useId, useRef, useState } from "react";
import { type TodoView, leftSubtasks } from "../todos";
import { useModal } from "./TemplateDialog";

/** サブタスクの進み具合「2/5」と細い棒。サブタスクが無ければ出さない */
export function Progress({ done, total }: { done: number; total: number }) {
  if (total === 0) return null;
  return (
    <span className={`progress${done === total ? " is-full" : ""}`} role="img" aria-label={`サブタスク ${done}/${total} 済み`}>
      <span className="progress__num" aria-hidden="true">
        {done}/{total}
      </span>
      <span className="progress__track" aria-hidden="true">
        <span className="progress__bar" style={{ width: `${(done / total) * 100}%` }} />
      </span>
    </span>
  );
}

/**
 * 済みにする前の確かめ。サブタスクが残っていれば「まとめて済みにしますか」と聞く。
 * ask() は、まとめてなら true、TODO だけなら false、やめたら null を返す（残りが無ければすぐ false）
 */
export function useAskDone(): { ask: (todo: TodoView) => Promise<boolean | null>; dialog: ReactNode } {
  const [asking, setAsking] = useState<TodoView | null>(null);
  const resolve = useRef<(v: boolean | null) => void>(() => {});
  const ask = (todo: TodoView) => {
    if (leftSubtasks(todo) === 0) return Promise.resolve(false);
    setAsking(todo);
    return new Promise<boolean | null>((r) => {
      resolve.current = r;
    });
  };
  const answer = (v: boolean | null) => {
    setAsking(null);
    resolve.current(v);
  };
  return { ask, dialog: asking && <AskDoneDialog todo={asking} onAnswer={answer} /> };
}

function AskDoneDialog({ todo, onAnswer }: { todo: TodoView; onAnswer: (v: boolean | null) => void }) {
  const { ref } = useModal(() => onAnswer(null));
  const titleId = useId();
  const left = leftSubtasks(todo);
  return (
    <dialog ref={ref} className="dialog" onClose={() => onAnswer(null)} aria-labelledby={titleId}>
      <h2 id={titleId}>残りのサブタスクもまとめて済みにしますか？</h2>
      <p>
        「{todo.title}」のサブタスクが、まだ{left}つ残っています。
      </p>
      <div className="form-actions">
        <button className="btn btn--primary" onClick={() => onAnswer(true)} autoFocus>
          はい、まとめて済みにする
        </button>
        <button className="btn" onClick={() => onAnswer(false)}>
          TODO だけ済みにする
        </button>
        <button className="btn btn--quiet" onClick={() => ref.current?.close()}>
          やめる
        </button>
      </div>
    </dialog>
  );
}
