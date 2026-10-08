// まとめて登録の表（PC 幅）。react-datasheet-grid の上に、マスで選ぶ小さな画面・範囲に同じ値（Ctrl/⌘+Enter）・元に戻すを足す。
// マスの値はすべて文字で持ち（貼り付け・コピーがそのまま効くように）、登録するときに読む。
import "react-datasheet-grid/dist/style.css";
import { type ReactNode, type RefObject, createContext, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type CellProps,
  type Column,
  type ContextMenuComponentProps,
  type ContextMenuItem,
  DataSheetGrid,
  type DataSheetGridRef,
  createContextMenuComponent,
} from "react-datasheet-grid";
import { type DateStr, addDays, daysInMonth, todayInTokyo, toDayNum, weekdayOf } from "../../shared/date";
import { WEEKDAYS, describeRule, shortDate } from "../../shared/describe";
import { evaluate } from "../../shared/schedule";
import { MAX_INTERVAL_DAYS, formatScheduleText, parseDateText, parseScheduleText } from "../../shared/schedule-text";
import type { ChoreTemplate } from "../../shared/templates";
import { ApiError, type Family, type Group, type Member, api } from "../api";
import { type CalState, CalendarFields, anchorOfCal, calValid, everyOfCal, initialCal, ruleOfCal } from "../components/CalendarFields";
import { TemplateDialog } from "../components/TemplateDialog";
import { errorText } from "../format";
import type { Nav } from "../router";
import type { BulkData } from "./ChoreBulk";

type GridRow = { id: string; name: string; group: string; schedule: string; due: string; assignee: string };
type Field = Exclude<keyof GridRow, "id">;
type Picker = "list" | "date" | "schedule";
type ColData = { field: Field; title: string; picker?: Picker; placeholder?: string };

/** 列の並び（col の番号はこの順） */
const COLS: ColData[] = [
  { field: "name", title: "家事の名前", placeholder: "例：シンクの排水口" },
  { field: "group", title: "グループ", picker: "list" },
  { field: "schedule", title: "周期", picker: "schedule", placeholder: "例：7日ごと、毎週 月・木" },
  { field: "due", title: "最初の期限", picker: "date" },
  { field: "assignee", title: "担当", picker: "list" },
];

let seq = 0;
const blankRow = (patch: Partial<GridRow> = {}): GridRow => ({ id: `r${++seq}`, name: "", group: "", schedule: "", due: "", assignee: "", ...patch });
const isBlank = (r: GridRow) => !r.name.trim();
const norm = (s: string) => s.normalize("NFKC").trim();

/** 1行を読んだ結果。errors は名前のある行だけ */
type Checked = {
  errors: Partial<Record<Field, string>>;
  /** 最初の期限のマスに薄く出す日付 */
  dueHint?: string;
  /** カレンダー固定（毎週・毎月）は最初の期限が要らない */
  dueDisabled: boolean;
  payload?: unknown;
};

function checkRow(r: GridRow, today: DateStr, groups: Group[], members: Member[]): Checked {
  const errors: Checked["errors"] = {};
  /** 名前の文字を id にする。空・「なし」は null、見つからなければ undefined */
  const lookup = <T,>(text: string, list: T[], nameOf: (t: T) => string, idOf: (t: T) => string) => {
    const t = norm(text);
    if (t === "" || t === "なし") return null;
    const hit = list.find((x) => norm(nameOf(x)) === t);
    return hit ? idOf(hit) : undefined;
  };
  const groupId = lookup(r.group, groups, (g) => g.name, (g) => g.id);
  if (groupId === undefined) errors.group = `「${r.group.trim()}」というグループはありません`;
  const userId = lookup(r.assignee, members, (m) => m.displayName, (m) => m.userId);
  if (userId === undefined) errors.assignee = `「${r.assignee.trim()}」という人は Family にいません`;
  if (r.name.trim().length > 40) errors.name = "名前は40字までです";

  const dueText = r.due.trim();
  const due = dueText ? parseDateText(dueText, today) : null;
  if (dueText && !due) errors.due = `「${dueText}」は日付として読めません（例：2026-10-20、10/20）`;

  let schedule: unknown;
  let dueHint: string | undefined;
  let dueDisabled = false;
  const p = parseScheduleText(r.schedule, today);
  if (!p.ok) errors.schedule = p.message;
  else if (p.kind === "interval") {
    dueHint = `今日 ${shortDate(today)}`;
    schedule = { type: "interval", intervalDays: p.intervalDays, firstDueOn: due ?? today };
  } else if (!p.needsAnchor) {
    dueDisabled = true;
    delete errors.due;
    const next = evaluate({ type: "calendar", rule: { ...p.rule, anchor: today } as never }, [], today).dueOn;
    dueHint = next ? `次は ${shortDate(next)}` : undefined;
    schedule = { type: "calendar", rule: p.rule };
  } else {
    dueHint = p.suggestedAnchor ? shortDate(p.suggestedAnchor) : undefined;
    schedule = { type: "calendar", rule: { ...p.rule, anchor: due ?? p.suggestedAnchor ?? today } };
  }

  if (isBlank(r)) return { errors: {}, dueHint, dueDisabled };
  const ok = Object.keys(errors).length === 0;
  return {
    errors,
    dueHint,
    dueDisabled,
    payload: ok ? { name: r.name.trim(), groupId, assigneeUserId: userId, schedule } : undefined,
  };
}

/** 表のマスから使うもの */
type GridCtxValue = {
  today: DateStr;
  checks: Map<string, Checked>;
  rowErrors: Record<string, string>;
  groups: Group[];
  members: Member[];
  /** 選ぶ画面で決めた値を入れる。範囲を選んでから開いていれば、範囲の全部の行に入れる */
  pick: (row: number, col: number, patch: Partial<GridRow>) => void;
  /** 編集をやめて、そのマスへ動く */
  moveTo: (row: number, col: number) => void;
};
const GridCtx = createContext<GridCtxValue | null>(null);

/** マスの中身。押す（またはダブルクリック・Enter）と、グループ・担当・周期・最初の期限は選ぶ画面が開く */
function GridCell({ rowData, rowIndex, columnIndex, focus, active, disabled, columnData: c, setRowData, stopEditing }: CellProps<GridRow, ColData>) {
  const ctx = useContext(GridCtx)!;
  const check = ctx.checks.get(rowData.id);
  const error = check?.errors[c.field];
  const rowError = ctx.rowErrors[rowData.id];
  const value = rowData[c.field];
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [hi, setHi] = useState(-1);
  const label = `${rowIndex + 1}行目の${c.title}`;

  useLayoutEffect(() => {
    if (focus) {
      inputRef.current?.focus();
      inputRef.current?.select();
      setHi(-1);
    }
  }, [focus]);

  const options = c.field === "group" ? ["なし", ...ctx.groups.map((g) => g.name)] : c.field === "assignee" ? ["なし", ...ctx.members.map((m) => m.displayName)] : [];
  const choose = (patch: Partial<GridRow>) => ctx.pick(rowIndex, columnIndex, patch);
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

  let shown: ReactNode = value;
  if (c.field === "due" && disabled) shown = <span className="bulk-grid__hint">{check?.dueHint ?? "—"}</span>;
  else if (c.field === "due" && value && !error) shown = shortDate(parseDateText(value, ctx.today)!);
  else if (!value) shown = c.field === "due" ? <span className="bulk-grid__hint">{check?.dueHint}</span> : active && c.placeholder ? <span className="bulk-grid__hint">{c.placeholder}</span> : null;

  return (
    <div
      ref={boxRef}
      className={`bulk-grid__cell${error ? " is-invalid" : ""}${rowError ? " is-row-error" : ""}`}
      title={error ?? rowError}
      data-cell={`${rowIndex + 1}-${c.field}`}
      onClick={(e) => {
        // 1回押しただけで選ぶ画面を開く（表は「選ぶ」と「編集」を分けているので、Enter を送って編集にする）
        if (c.picker && !focus && !disabled && !e.shiftKey) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }}
    >
      {focus ? (
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
      {focus && c.picker && (
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
            <SchedulePicker text={value} due={parseDateText(rowData.due, ctx.today)} today={ctx.today} onPick={choose} />
          )}
        </Popover>
      )}
      {error && <span className="visually-hidden">（{error}）</span>}
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
function DatePicker({ value, today, onPick }: { value: DateStr | null; today: DateStr; onPick: (d: DateStr) => void }) {
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

/** 周期を選ぶ小さな画面。決めると、その周期の文字がマスに入る */
function SchedulePicker({ text, due, today, onPick }: { text: string; due: DateStr | null; today: DateStr; onPick: (patch: Partial<GridRow>) => void }) {
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
const ContextMenu = (p: ContextMenuComponentProps) => <Menu {...p} />;

const ROW_HEIGHT = 40;

/** PC 幅：エクセルのような表でまとめて登録。名前が空の行は登録しない */
export function ChoreBulkGrid({ family, nav, data: { groups, members, existing } }: { family: Family; nav: Nav; data: BulkData }) {
  const today = todayInTokyo();
  const [rows, setRowsState] = useState<GridRow[]>(() => Array.from({ length: 5 }, () => blankRow()));
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);

  const gridRef = useRef<DataSheetGridRef>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const editingRef = useRef(false);
  /** 編集を始める前に選んでいた範囲（Ctrl/⌘+Enter と選ぶ画面で、範囲に同じ値を入れるため） */
  const rangeRef = useRef<DataSheetGridRef["selection"]>(null);
  const undoRef = useRef<GridRow[][]>([]);
  const redoRef = useRef<GridRow[][]>([]);
  /** 1回の編集（1つのマスに打っている間）は、元に戻す単位を1つにまとめる */
  const pushedInEditRef = useRef(false);

  const checks = useMemo(() => new Map(rows.map((r) => [r.id, checkRow(r, today, groups, members)])), [rows, today, groups, members]);
  const checksRef = useRef(checks);
  checksRef.current = checks;

  const commit = (next: GridRow[]) => {
    if (!editingRef.current || !pushedInEditRef.current) {
      undoRef.current = [...undoRef.current.slice(-99), rowsRef.current];
      redoRef.current = [];
      if (editingRef.current) pushedInEditRef.current = true;
    }
    // 最後の行に名前が入ったら、空の行を1つ足す（表に書き足していく感覚で）
    if (next.length === 0 || !isBlank(next[next.length - 1]!)) next = [...next, blankRow()];
    const prev = new Map(rowsRef.current.map((r) => [r.id, r]));
    setRowErrors((errs) => Object.fromEntries(Object.entries(errs).filter(([id]) => prev.get(id) === next.find((r) => r.id === id))));
    rowsRef.current = next;
    setRowsState(next);
    bump();
  };
  const restore = (from: RefObject<GridRow[][]>, to: RefObject<GridRow[][]>) => {
    const last = from.current.at(-1);
    if (!last) return;
    from.current = from.current.slice(0, -1);
    to.current = [...to.current, rowsRef.current];
    rowsRef.current = last;
    setRowsState(last);
    bump();
  };
  const undo = () => restore(undoRef, redoRef);
  const redo = () => restore(redoRef, undoRef);

  /** 範囲（無ければそのマス）の全部に入れる。field ごとに値を決める */
  const fillRange = (row: number, col: number, valueFor: (field: Field, r: GridRow) => Partial<GridRow>, sameColumnOnly: boolean) => {
    const sel = rangeRef.current;
    const inSel = sel && row >= sel.min.row && row <= sel.max.row && col >= sel.min.col && col <= sel.max.col;
    const min = inSel ? sel.min : { row, col };
    const max = inSel ? sel.max : { row, col };
    const cols = sameColumnOnly ? [col] : Array.from({ length: max.col - min.col + 1 }, (_, i) => min.col + i);
    const next = rowsRef.current.map((r, i) => {
      if (i < min.row || i > max.row) return r;
      let out = r;
      for (const c of cols) {
        const field = COLS[c]!.field;
        if (field === "due" && checksRef.current.get(out.id)?.dueDisabled) continue;
        out = { ...out, ...valueFor(field, out) };
      }
      return out;
    });
    commit(next);
    const g = gridRef.current;
    if (inSel && (sel.min.row !== sel.max.row || sel.min.col !== sel.max.col)) g?.setSelection(sel);
    else g?.setActiveCell({ row, col });
  };

  const ctx: GridCtxValue = {
    today,
    checks,
    rowErrors,
    groups,
    members,
    pick: (row, col, patch) => fillRange(row, col, () => patch, true),
    moveTo: (row, col) => gridRef.current?.setActiveCell({ row, col: Math.max(0, Math.min(COLS.length - 1, col)) }),
  };

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
      const text = rowsRef.current[row]?.[COLS[col]!.field] ?? "";
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

  const columns = useMemo<Column<GridRow, ColData>[]>(
    () =>
      COLS.map((c) => ({
        id: c.field,
        title: c.title,
        basis: c.field === "name" ? 240 : c.field === "schedule" || c.field === "due" ? 180 : 140,
        grow: c.field === "name" ? 2 : 1,
        minWidth: c.field === "name" ? 180 : 120,
        component: GridCell,
        columnData: c,
        // 選ぶ画面のある列は、編集中の矢印・Enter・Tab をマスの中で受ける。小さな画面を押しても編集を続ける
        disableKeys: !!c.picker,
        keepFocus: !!c.picker,
        disabled: c.field === "due" ? ({ rowData }) => !!checksRef.current.get(rowData.id)?.dueDisabled : false,
        copyValue: ({ rowData }) => rowData[c.field],
        pasteValue: ({ rowData, value }) => ({ ...rowData, [c.field]: value.replace(/[\n\r]+/g, " ").trim() }),
        deleteValue: ({ rowData }) => ({ ...rowData, [c.field]: "" }),
        isCellEmpty: ({ rowData }) => !rowData[c.field],
      })),
    [],
  );

  const addTemplates = (picked: ChoreTemplate[]) => {
    const groupNames = new Set(groups.map((g) => g.name));
    const added = picked.map((t) =>
      blankRow({
        name: t.name,
        group: groupNames.has(t.group) ? t.group : "",
        ...(t.schedule.type === "interval"
          ? // 前にやった日は分からないので、今日から1周期あとを最初の期限にしておく
            { schedule: `${t.schedule.intervalDays}日ごと`, due: addDays(today, t.schedule.intervalDays) }
          : { schedule: describeRule({ kind: "weekly", weekdays: t.schedule.weekdays, every: 1, anchor: today }) }),
      }),
    );
    commit([...rows.filter((r) => !isBlank(r)), ...added]);
    setPicking(false);
  };

  const filled = rows.filter((r) => !isBlank(r));
  const invalid = filled.filter((r) => !checks.get(r.id)?.payload);

  const submit = async () => {
    setError(null);
    if (invalid.length) {
      setError(`赤いマスを直してください（${invalid.length}行）`);
      return;
    }
    setBusy(true);
    setRowErrors({});
    try {
      const res = await api<{ created: number }>("POST", `/families/${family.id}/chores/bulk`, { chores: filled.map((r) => checks.get(r.id)!.payload) });
      sessionStorage.setItem("kaji.flash", `${res.created}件の家事を登録しました`);
      nav.go({ name: "chores" });
    } catch (e) {
      if (e instanceof ApiError && e.code === "bulk_invalid" && e.detail?.rows) {
        const map: Record<string, string> = {};
        for (const { index, message } of e.detail.rows as { index: number; message: string }[]) if (filled[index]) map[filled[index].id] = message;
        setRowErrors(map);
      }
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // 表の下に出す、行ごとの直すところ・注意
  const notes = rows.flatMap((r, i) => {
    if (isBlank(r)) return [];
    const out: { key: string; text: string; error: boolean }[] = [];
    const errs = checks.get(r.id)?.errors ?? {};
    for (const c of COLS) if (errs[c.field]) out.push({ key: `${r.id}-${c.field}`, text: `${i + 1}行目・${c.title}：${errs[c.field]}`, error: true });
    if (rowErrors[r.id]) out.push({ key: `${r.id}-server`, text: `${i + 1}行目：${rowErrors[r.id]}`, error: true });
    if (existing.includes(r.name.trim())) out.push({ key: `${r.id}-dup`, text: `${i + 1}行目：同じ名前の家事が、もうあります`, error: false });
    return out;
  });

  return (
    <main className="page page--wide">
      <div className="page-head">
        <h1>まとめて登録</h1>
        <button className="btn" onClick={() => setPicking(true)}>
          よくある家事から選ぶ
        </button>
      </div>
      <p className="muted">
        1行に1つの家事を書きます。名前が空の行は登録しません。Excel やスプレッドシートから貼り付けもできます。範囲を選んで打ち、Ctrl（⌘）+Enter
        で範囲の全部に同じ値が入ります。最初の期限は、前にやった日が分かればその日に周期を足した日にしてください。
      </p>

      <GridCtx.Provider value={ctx}>
        <div className="bulk-grid">
          <DataSheetGrid<GridRow>
            ref={gridRef}
            value={rows}
            onChange={(next) => commit(next)}
            columns={columns}
            rowKey="id"
            createRow={() => blankRow()}
            duplicateRow={({ rowData }) => ({ ...rowData, id: blankRow().id })}
            rowHeight={ROW_HEIGHT}
            headerRowHeight={ROW_HEIGHT}
            height={ROW_HEIGHT * 16}
            addRowsComponent={false}
            contextMenuComponent={ContextMenu}
            onFocus={() => {
              editingRef.current = true;
              pushedInEditRef.current = false;
            }}
            onBlur={() => {
              editingRef.current = false;
            }}
          />
        </div>
      </GridCtx.Provider>

      {notes.length > 0 && (
        <ul className="bulk-notes">
          {notes.map((n) => (
            <li key={n.key} className={n.error ? "error" : "muted"}>
              {n.text}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions bulk-actions">
        <button className="btn btn--primary" disabled={busy || filled.length === 0} onClick={() => void submit()}>
          {filled.length > 0 ? `${filled.length}件を登録` : "登録する家事がありません"}
        </button>
        <button
          className="btn"
          onClick={() => {
            commit([...rows, blankRow()]);
            gridRef.current?.setActiveCell({ row: rows.length, col: 0 });
          }}
        >
          行を足す
        </button>
        <button className="btn btn--quiet" disabled={undoRef.current.length === 0} onClick={undo}>
          元に戻す
        </button>
        <button className="btn btn--quiet" onClick={() => nav.back({ name: "chores" })}>
          やめる
        </button>
      </div>

      {picking && <TemplateDialog existing={[...existing, ...filled.map((r) => r.name.trim())]} onCancel={() => setPicking(false)} onAdd={addTemplates} />}
    </main>
  );
}
