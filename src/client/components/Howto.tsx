// 家事の「やり方」（Markdown）。表示・書く欄（PC は左に入力・右にプレビュー、スマホは「書く／見る」の切り替え）・今日の札から開く画面
import { Suspense, lazy, useId, useState } from "react";
import { createPortal } from "react-dom";
import type { ChoreView } from "../chores";
import { formatDateTime } from "../format";
import { useModal } from "./TemplateDialog";

export const HOWTO_MAX = 10000;

const LazyMarkdown = lazy(() => import("./Markdown"));

export function Markdown({ text }: { text: string }) {
  return (
    <Suspense fallback={<p className="muted">読み込んでいます…</p>}>
      <LazyMarkdown text={text} />
    </Suspense>
  );
}

/** 「最後に直した人 ○○・日時」 */
export function HowtoMeta({ chore }: { chore: Pick<ChoreView, "howtoUpdatedAt" | "howtoUpdatedByName"> }) {
  if (!chore.howtoUpdatedAt) return null;
  return (
    <p className="howto__meta">
      最後に直した人 {chore.howtoUpdatedByName ?? "（抜けた人）"}・{formatDateTime(chore.howtoUpdatedAt)}
    </p>
  );
}

export const howtoLength = (text: string) => [...text].length;

/** やり方を書く欄。PC 幅では左に入力・右にプレビュー、スマホ幅では「書く／見る」を切り替える */
export function HowtoEditor({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const [mode, setMode] = useState<"write" | "view">("write");
  const id = useId();
  const len = howtoLength(value);
  return (
    <div className="howto-editor" data-mode={mode}>
      <div className="howto-editor__head">
        <label htmlFor={`${id}-text`} className="howto-editor__label">
          やり方（Markdown）
        </label>
        <div className="segmented howto-editor__tabs" role="tablist" aria-label="やり方の表示">
          {(["write", "view"] as const).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}>
              {m === "write" ? "書く" : "見る"}
            </button>
          ))}
        </div>
      </div>
      <div className="howto-editor__panes">
        <textarea
          id={`${id}-text`}
          className="howto-editor__text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={"例：\n## 用意するもの\n- 中性洗剤\n- スポンジ\n\n## 手順\n- [ ] 排水口のふたを外す\n- [ ] **ぬめり**を落とす"}
          autoFocus={autoFocus}
          aria-describedby={`${id}-help`}
          aria-invalid={len > HOWTO_MAX ? true : undefined}
        />
        <div className="howto-editor__preview" aria-label="プレビュー" role="region">
          {value.trim() ? <Markdown text={value} /> : <p className="muted">ここに見た目が出ます。</p>}
        </div>
      </div>
      <p id={`${id}-help`} className={len > HOWTO_MAX ? "error" : "muted"}>
        {len > HOWTO_MAX ? `${HOWTO_MAX}文字までです（いま ${len}文字）。` : `${len} / ${HOWTO_MAX}文字。`}
        「## 見出し」「- 箇条書き」「- [ ] 手順の印」「**太字**」「[文字](https://…)」、表も書けます。
      </p>
    </div>
  );
}

/** 今日の札の「やり方」から開く画面 */
export function HowtoDialog({ chore, onClose }: { chore: ChoreView; onClose: () => void }) {
  const { ref } = useModal(onClose);
  const titleId = useId();
  return (
    <dialog ref={ref} className="dialog dialog--wide howto-dialog" onClose={onClose} aria-labelledby={titleId}>
      <h2 id={titleId}>{chore.name}のやり方</h2>
      <div className="howto-dialog__body">
        <Markdown text={chore.howto ?? ""} />
      </div>
      <HowtoMeta chore={chore} />
      <div className="form-actions">
        <button className="btn" onClick={() => ref.current?.close()} autoFocus>
          閉じる
        </button>
      </div>
    </dialog>
  );
}

/** 表で編集のやり方のマスから開く画面。書く欄とプレビュー。「決める」でマスに入れる（保存は表の保存ボタンで） */
export function HowtoCellDialog({ title, value, onSave, onCancel }: { title: string; value: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(value);
  const { ref } = useModal(onCancel);
  const titleId = useId();
  const tooLong = howtoLength(text) > HOWTO_MAX;
  // 表の中に置くと、画面を押したのを表がマスを押したと受け取るので body に出す
  return createPortal(
    <dialog ref={ref} className="dialog dialog--wide howto-dialog" onClose={onCancel} aria-labelledby={titleId} onKeyDown={(e) => e.stopPropagation()}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!tooLong) onSave(text);
        }}
      >
        <h2 id={titleId}>{title}</h2>
        <HowtoEditor value={text} onChange={setText} autoFocus />
        <div className="form-actions">
          <button type="submit" className="btn btn--primary" disabled={tooLong}>
            決める
          </button>
          <button type="button" className="btn btn--quiet" onClick={onCancel}>
            やめる
          </button>
        </div>
        <p className="muted">決めたあと、表の下の保存ボタンで保存します。</p>
      </form>
    </dialog>,
    document.body,
  );
}
