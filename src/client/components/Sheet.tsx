// エクセルのような表の部品（まとめて登録・表で直すで使う）。react-datasheet-grid の上に、マスで選ぶ小さな画面・
// 範囲に同じ値（Ctrl/⌘+Enter）・元に戻すを足す。マスの値はすべて文字で持つ（貼り付け・コピーがそのまま効くように）。
import "react-datasheet-grid/dist/style.css";
import { type ReactNode, type RefObject, createContext, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type CellProps, type Column, type ContextMenuComponentProps, type ContextMenuItem, type DataSheetGridRef, createContextMenuComponent } from "react-datasheet-grid";
import { type DateStr, addDays, daysInMonth, toDayNum, weekdayOf } from "../../shared/date";
import { WEEKDAYS } from "../../shared/describe";
import { MAX_INTERVAL_DAYS, formatScheduleText, parseDateText, parseScheduleText } from "../../shared/schedule-text";
import { type CalState, CalendarFields, anchorOfCal, calValid, everyOfCal, initialCal, ruleOfCal } from "./CalendarFields";

/** 表の1行。id のほかは全部文字 */
export type SheetRow = { id: string } & Record<string, string>;
/** マスを押すと開くもの。check はチェックの入り切り */
export type Picker = "list" | "date" | "schedule" | "check";
export type SheetCol = { field: string; title: string; picker?: Picker; placeholder?: string; basis: number; grow?: number; minWidth?: number };

/** チェックの入ったマスの文字 */
export const CHECKED = "✓";
/** 貼り付けで「入っていない」とみなす文字（react-datasheet-grid の checkboxColumn と同じ考え） */
const FALSY = ["", "false", "no", "off", "0", "n", "f", "×", "x", "いいえ", "なし"];
const checkText = (text: string) => (FALSY.includes(text.normalize("NFKC").trim().toLowerCase()) ? "" : CHECKED);

export const norm = (s: string) => s.normalize("NFKC").trim();

/** マスの見え方。shown を返せば値の代わりにそれを出す */
export type CellState = { error?: string; rowError?: string; changed?: boolean; shown?: ReactNode };

/** 表のマスから使うもの */
export type SheetCtxValue = {
  today: DateStr;
  cellOf: (row: SheetRow, field: string, disabled: boolean) => CellState;
  /** list のマスの候補（「なし」は空にする） */
  options: (field: string) => string[];
  /** 選ぶ画面で決めた値を入れる。範囲を選んでから開いていれば、範囲の全部の行に入れる */
  pick: (row: number, col: number, patch: Record<string, string>) => void;
  /** 編集をやめて、そのマスへ動く */
  moveTo: (row: number, col: number) => void;
};
export const SheetCtx = createContext<SheetCtxValue | null>(null);

/** マスの中身。押す（またはダブルクリック・Enter）と、選ぶ画面のある列は小さな画面が開く。check の列は押すと入り切りする */
function SheetCell({ rowData, rowIndex, columnIndex, focus, active, disabled, columnData: c, setRowData, stopEditing }: CellProps<SheetRow, SheetCol>) {
  const ctx = useContext(SheetCtx)!;
  const { error, rowError, changed, shown: override } = ctx.cellOf(rowData, c.field, disabled);
  const value = rowData[c.field] ?? "";
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [hi, setHi] = useState(-1);
  const wasActiveRef = useRef(false);
  const label = `${rowIndex + 1}行目の${c.title}`;
  const choose = (patch: Record<string, string>) => ctx.pick(rowIndex, columnIndex, patch);

  useLayoutEffect(() => {
    if (!focus) return;
    if (c.picker === "check") {
      // 編集になったら（Enter・選んであるマスを押す）すぐ入り切りして、そのマスに留まる
      choose({ [c.field]: value ? "" : CHECKED });
      stopEditing({ nextRow: false });
      return;
    }
    inputRef.current?.focus();
    inputRef.current?.select();
    setHi(-1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const options = c.picker === "list" ? ["なし", ...ctx.options(c.field)] : [];
  const chooseText = (text: string) => choose({ [c.field]: text === "なし" ? "" : text });

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!c.picker || e.nativeEvent.isComposing) return; // 名前の列は表のほうで動く
    // 受けたキーは表（document で聞いている）に渡さない。渡すと、動いた先のマスでまた編集が始まる
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      handled();
      if (c.picker === "list" && hi >= 0 && options[hi] !== undefined) chooseText(options[hi]);
      else stopEditing();
    } else if (e.key === "Tab") {
      handled();
      ctx.moveTo(rowIndex, columnIndex + (e.shiftKey ? -1 : 1));
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      handled();
      if (c.picker === "list") setHi((h) => (e.key === "ArrowDown" ? Math.min(options.length - 1, h + 1) : Math.max(0, h - 1)));
      else if (e.key === "ArrowDown") document.querySelector<HTMLElement>(".grid-popover button, .grid-popover input")?.focus();
    }
  };

  const shown: ReactNode = override !== undefined ? override : value ? value : active && c.placeholder ? <span className="bulk-grid__hint">{c.placeholder}</span> : null;
  const cls = `bulk-grid__cell${error ? " is-invalid" : ""}${rowError ? " is-row-error" : ""}${changed ? " is-changed" : ""}${c.picker === "check" ? " is-check" : ""}`;

  return (
    <div
      ref={boxRef}
      className={cls}
      title={error ?? rowError ?? (changed ? "変えたマス（まだ保存していません）" : undefined)}
      data-cell={`${rowIndex + 1}-${c.field}`}
      onMouseDown={() => {
        wasActiveRef.current = active;
      }}
      onClick={(e) => {
        // 1回押しただけで選ぶ画面を開く・チェックを入り切りする（表は「選ぶ」と「編集」を分けているので、Enter を送って編集にする）。
        // 選んであったマスは、押したときに表が編集にしているので送らない（送るとチェックが2回変わる）
        if (!c.picker || focus || disabled || e.shiftKey) return;
        if (c.picker === "check" && wasActiveRef.current) return;
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }}
    >
      {c.picker === "check" ? (
        <input type="checkbox" className="dsg-checkbox" tabIndex={-1} checked={!!value} disabled={disabled} aria-label={label} onChange={() => null} />
      ) : focus ? (
        <input
          ref={inputRef}
          className="dsg-input"
          value={value}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          onChange={(e) => setRowData({ ...rowData, [c.field]: e.target.value })}
          onKeyDown={onKeyDown}
        />
      ) : (
        <span className="bulk-grid__text">{shown}</span>
      )}
      {focus && c.picker && c.picker !== "check" && (
        <Popover anchor={boxRef} label={`${label}を選ぶ`} onDismiss={() => stopEditing({ nextRow: false })}>
          {c.picker === "list" ? (
            <ul className="pick-list" role="listbox" aria-label={c.title}>
              {options.map((o, i) => (
                <li
                  key={o}
                  role="option"
                  aria-selected={norm(value) === norm(o) || (o === "なし" && !value.trim())}
                  className={i === hi ? "is-hi" : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => chooseText(o)}
                >
                  {o}
                </li>
              ))}
            </ul>
          ) : c.picker === "date" ? (
            <DatePicker value={parseDateText(value, ctx.today)} today={ctx.today} onPick={(d) => chooseText(d)} />
          ) : (
            <SchedulePicker text={value} due={parseDateText(rowData.due ?? "", ctx.today)} today={ctx.today} onPick={choose} />
          )}
        </Popover>
      )}
      {(error || changed) && <span className="visually-hidden">（{error ?? "変更あり"}）</span>}
    </div>
  );
}

/** マスのすぐ近くに出す小さな画面。外を押すと閉じる（Esc は表が閉じる） */
function Popover({ anchor, label, onDismiss, children }: { anchor: RefObject<HTMLDivElement | null>; label: string; onDismiss: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const p = ref.current?.getBoundingClientRect();
      if (!a || !p) return;
      let top = a.bottom + 4;
      if (top + p.height > innerHeight - 8) top = a.top - p.height - 4 >= 8 ? a.top - p.height - 4 : Math.max(8, innerHeight - p.height - 8);
      setPos({ left: Math.max(8, Math.min(a.left, innerWidth - p.width - 8)), top });
    };
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    addEventListener("scroll", place, true);
    addEventListener("resize", place);
    return () => {
      ro.disconnect();
      removeEventListener("scroll", place, true);
      removeEventListener("resize", place);
    };
  }, [anchor]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      // 表の中を押したときは表が動かす
      if (ref.current?.contains(t) || anchor.current?.closest(".dsg-container")?.contains(t)) return;
      dismiss.current();
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [anchor]);

  return createPortal(
    <div ref={ref} className="grid-popover" role="dialog" aria-label={label} style={pos ?? { left: -9999, top: 0 }}>
      {children}
    </div>,
    document.body,
  );
}

/** 日付を選ぶカレンダー */
export function DatePicker({ value, today, onPick }: { value: DateStr | null; today: DateStr; onPick: (d: DateStr) => void }) {
  const [ym, setYm] = useState(() => (value ?? today).slice(0, 7));
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const first = `${ym}-01`;
  const lead = weekdayOf(toDayNum(first));
  const days = Array.from({ length: daysInMonth(y, m) }, (_, i) => addDays(first, i));
  const shift = (n: number) => {
    const t = y * 12 + (m - 1) + n;
    setYm(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`);
  };
  const noFocusSteal = (e: React.MouseEvent) => e.preventDefault();
  return (
    <div className="date-picker">
      <div className="date-picker__head">
        <button type="button" className="btn btn--quiet btn--small" onMouseDown={noFocusSteal} onClick={() => shift(-1)} aria-label="前の月">
          ‹
        </button>
        <span>
          {y}年{m}月
        </span>
        <button type="button" className="btn btn--quiet btn--small" onMouseDown={noFocusSteal} onClick={() => shift(1)} aria-label="次の月">
          ›
        </button>
      </div>
      <div className="date-picker__grid">
        {WEEKDAYS.map((w) => (
          <span key={w} className="date-picker__wd" aria-hidden="true">
            {w}
          </span>
        ))}
        {days.map((d, i) => (
          <button
            key={d}
            type="button"
            style={i === 0 ? { gridColumnStart: lead + 1 } : undefined}
            className={`date-picker__day${d === today ? " is-today" : ""}${d === value ? " is-selected" : ""}`}
            aria-label={`${m}月${i + 1}日（${WEEKDAYS[weekdayOf(toDayNum(d))]}）`}
            aria-pressed={d === value}
            onMouseDown={noFocusSteal}
            onClick={() => onPick(d)}
          >
            {i + 1}
          </button>
        ))}
      </div>
      <div className="date-picker__foot">
        <button type="button" className="btn btn--small" onMouseDown={noFocusSteal} onClick={() => onPick(today)}>
          今日
        </button>
        <span className="muted">「10/20」と打っても入ります</span>
      </div>
    </div>
  );
}

/** 周期を選ぶ小さな画面。決めると、その周期の文字がマスに入る（隔週・数か月ごとは最初の予定日を due に） */
export function SchedulePicker({ text, due, today, onPick }: { text: string; due: DateStr | null; today: DateStr; onPick: (patch: { schedule: string; due?: string }) => void }) {
  const [init] = useState(() => {
    const p = parseScheduleText(text, today);
    if (p.ok && p.kind === "calendar") return { type: "calendar" as const, days: "7", cal: initialCal(today, { ...p.rule, anchor: due ?? p.suggestedAnchor ?? today } as never) };
    return { type: "interval" as const, days: p.ok ? String(p.intervalDays) : "7", cal: initialCal(today) };
  });
  const [type, setType] = useState<"interval" | "calendar">(init.type);
  const [days, setDays] = useState(init.days);
  const [cal, setCal] = useState<CalState>(init.cal);
  const n = Number(days);
  const ok = type === "interval" ? Number.isInteger(n) && n >= 1 && n <= MAX_INTERVAL_DAYS : calValid(cal);
  const result = !ok
    ? null
    : type === "interval"
      ? formatScheduleText({ type: "interval", intervalDays: n, firstDueOn: today })
      : formatScheduleText({ type: "calendar", rule: ruleOfCal(cal, anchorOfCal(cal, today)) });

  const decide = () => {
    if (!result) return;
    // 隔週・数か月ごとは、最初の予定日を最初の期限の列に入れる
    onPick(type === "calendar" && everyOfCal(cal) >= 2 ? { schedule: result, due: anchorOfCal(cal, today) } : { schedule: result });
  };

  return (
    <div className="schedule-picker">
      <fieldset className="fieldset">
        <legend>周期の決め方</legend>
        <label className="radio">
          <input type="radio" name="grid-type" checked={type === "interval"} onChange={() => setType("interval")} />
          <span>日数（何日ごと）</span>
        </label>
        <label className="radio">
          <input type="radio" name="grid-type" checked={type === "calendar"} onChange={() => setType("calendar")} />
          <span>カレンダーで決まった日</span>
        </label>
      </fieldset>
      {type === "interval" ? (
        <label className="field field--short interval-field">
          <span>何日ごと</span>
          <span className="cycle-cell">
            <input type="number" min={1} max={MAX_INTERVAL_DAYS} value={days} onChange={(e) => setDays(e.target.value)} />
            <span>日ごと</span>
          </span>
        </label>
      ) : (
        <CalendarFields value={cal} onChange={setCal} today={today} idPrefix="grid-cal" />
      )}
      <p className="preview">{result ?? (type === "interval" ? `1〜${MAX_INTERVAL_DAYS}日で書いてください` : "曜日を1つ以上選んでください")}</p>
      <div className="form-actions">
        <button type="button" className="btn btn--primary" disabled={!result} onClick={decide}>
          決める
        </button>
      </div>
    </div>
  );
}

const Menu = createContextMenuComponent((item: ContextMenuItem) => {
  switch (item.type) {
    case "COPY":
      return <>コピー</>;
    case "CUT":
      return <>切り取り</>;
    case "PASTE":
      return <>貼り付け</>;
    case "INSERT_ROW_BELLOW":
      return <>下に行を足す</>;
    case "DUPLICATE_ROW":
      return <>この行を複製</>;
    case "DUPLICATE_ROWS":
      return (
        <>
          {item.fromRow}〜{item.toRow}行目を複製
        </>
      );
    case "DELETE_ROW":
      return <>この行を消す</>;
    case "DELETE_ROWS":
      return (
        <>
          {item.fromRow}〜{item.toRow}行目を消す
        </>
      );
  }
});
/** 右クリックのメニュー（日本語） */
export const ContextMenu = (p: ContextMenuComponentProps) => <Menu {...p} />;

export const ROW_HEIGHT = 40;

type SheetOptions<R extends SheetRow> = {
  cols: SheetCol[];
  initial: () => R[];
  /** 変えた行の並びを整える（まとめて登録で、末尾に空の行を足すなど） */
  normalize?: (next: R[]) => R[];
  /** 変えたあとに呼ぶ（行の不備の知らせを消すなど） */
  onCommit?: (prev: R[], next: R[]) => void;
  /** 範囲に同じ値を入れるとき、飛ばすマス・選べないマス */
  disabled?: (field: string, row: R) => boolean;
};

/**
 * 表の状態と操作：元に戻す・やり直す、範囲に同じ値（Ctrl/⌘+Enter と選ぶ画面）、列の定義。
 * 表は .bulk-grid の中に置き、DataSheetGrid に gridProps を渡す。
 */
export function useSheet<R extends SheetRow>(o: SheetOptions<R>) {
  const [rows, setRowsState] = useState<R[]>(o.initial);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const optsRef = useRef(o);
  optsRef.current = o;

  const gridRef = useRef<DataSheetGridRef>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const editingRef = useRef(false);
  /** 編集を始める前に選んでいた範囲（Ctrl/⌘+Enter と選ぶ画面で、範囲に同じ値を入れるため） */
  const rangeRef = useRef<DataSheetGridRef["selection"]>(null);
  const undoRef = useRef<R[][]>([]);
  const redoRef = useRef<R[][]>([]);
  /** 1回の編集（1つのマスに打っている間）は、元に戻す単位を1つにまとめる */
  const pushedInEditRef = useRef(false);

  const setRows = (next: R[]) => {
    rowsRef.current = next;
    setRowsState(next);
    bump();
  };
  const commit = (next: R[]) => {
    if (!editingRef.current || !pushedInEditRef.current) {
      undoRef.current = [...undoRef.current.slice(-99), rowsRef.current];
      redoRef.current = [];
      if (editingRef.current) pushedInEditRef.current = true;
    }
    next = optsRef.current.normalize?.(next) ?? next;
    optsRef.current.onCommit?.(rowsRef.current, next);
    setRows(next);
  };
  const restore = (from: RefObject<R[][]>, to: RefObject<R[][]>) => {
    const last = from.current.at(-1);
    if (!last) return;
    from.current = from.current.slice(0, -1);
    to.current = [...to.current, rowsRef.current];
    setRows(last);
  };
  const undo = () => restore(undoRef, redoRef);
  const redo = () => restore(redoRef, undoRef);

  /** 範囲（無ければそのマス）の全部に入れる。field ごとに値を決める */
  const fillRange = (row: number, col: number, valueFor: (field: string, r: R) => Record<string, string>, sameColumnOnly: boolean) => {
    const sel = rangeRef.current;
    const inSel = sel && row >= sel.min.row && row <= sel.max.row && col >= sel.min.col && col <= sel.max.col;
    const min = inSel ? sel.min : { row, col };
    const max = inSel ? sel.max : { row, col };
    const cols = sameColumnOnly ? [col] : Array.from({ length: max.col - min.col + 1 }, (_, i) => min.col + i);
    const next = rowsRef.current.map((r, i) => {
      if (i < min.row || i > max.row) return r;
      let out = r;
      for (const c of cols) {
        const field = optsRef.current.cols[c]!.field;
        if (optsRef.current.disabled?.(field, out)) continue;
        out = { ...out, ...valueFor(field, out) };
      }
      return out;
    });
    commit(next);
    const g = gridRef.current;
    if (inSel && (sel.min.row !== sel.max.row || sel.min.col !== sel.max.col)) g?.setSelection(sel);
    else g?.setActiveCell({ row, col });
  };

  const pick = (row: number, col: number, patch: Record<string, string>) => fillRange(row, col, () => patch, true);
  const moveTo = (row: number, col: number) => gridRef.current?.setActiveCell({ row, col: Math.max(0, Math.min(optsRef.current.cols.length - 1, col)) });

  // 表の外側のキー：Ctrl/⌘+Enter（範囲に同じ値）、Ctrl/⌘+Z・Y（元に戻す・やり直す）。表より先に受ける
  const keyRef = useRef<(e: KeyboardEvent) => void>(null);
  keyRef.current = (e) => {
    const g = gridRef.current;
    const mod = e.ctrlKey || e.metaKey;
    if (!editingRef.current) {
      rangeRef.current = g?.selection ?? null;
      const t = e.target as HTMLElement;
      const outside = t !== document.body && !t.closest?.(".bulk-grid");
      if (!mod || outside || e.isComposing) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) undo();
      else if (k === "y" || (k === "z" && e.shiftKey)) redo();
      else return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === "Enter" && mod && g?.activeCell) {
      const { row, col } = g.activeCell;
      const text = rowsRef.current[row]?.[optsRef.current.cols[col]!.field] ?? "";
      e.preventDefault();
      e.stopPropagation();
      fillRange(row, col, (field) => ({ [field]: text }), false);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current?.(e);
    const onDown = () => {
      if (!editingRef.current) rangeRef.current = null;
    };
    addEventListener("keydown", onKey, true);
    addEventListener("mousedown", onDown, true);
    return () => {
      removeEventListener("keydown", onKey, true);
      removeEventListener("mousedown", onDown, true);
    };
  }, []);

  const columns = useMemo<Column<R, SheetCol>[]>(
    () =>
      o.cols.map((c) => ({
        id: c.field,
        title: c.title,
        basis: c.basis,
        grow: c.grow ?? 1,
        minWidth: c.minWidth ?? 120,
        component: SheetCell as unknown as Column<R, SheetCol>["component"],
        columnData: c,
        // 選ぶ画面のある列は、編集中の矢印・Enter・Tab をマスの中で受ける。小さな画面を押しても編集を続ける
        disableKeys: !!c.picker,
        keepFocus: !!c.picker,
        disabled: ({ rowData }) => !!optsRef.current.disabled?.(c.field, rowData),
        copyValue: ({ rowData }) => rowData[c.field] ?? "",
        pasteValue: ({ rowData, value }) => {
          const text = value.replace(/[\n\r]+/g, " ").trim();
          return { ...rowData, [c.field]: c.picker === "check" ? checkText(text) : text };
        },
        deleteValue: ({ rowData }) => ({ ...rowData, [c.field]: "" }),
        isCellEmpty: ({ rowData }) => !rowData[c.field],
      })),
    // 列は最初に決めたまま（中で使う関数は optsRef で新しいものを見る）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return {
    rows,
    commit,
    undo,
    canUndo: undoRef.current.length > 0,
    gridRef,
    pick,
    moveTo,
    gridProps: {
      ref: gridRef,
      value: rows,
      onChange: (next: R[]) => commit(next),
      columns,
      rowKey: "id" as const,
      rowHeight: ROW_HEIGHT,
      headerRowHeight: ROW_HEIGHT,
      contextMenuComponent: ContextMenu,
      onFocus: () => {
        editingRef.current = true;
        pushedInEditRef.current = false;
      },
      onBlur: () => {
        editingRef.current = false;
      },
    },
  };
}
