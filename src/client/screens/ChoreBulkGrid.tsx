// まとめて登録の表（PC 幅）。表の部品は components/Sheet。マスの値は文字で持ち、登録するときに読む。
import { useMemo, useRef, useState } from "react";
import { DataSheetGrid } from "react-datasheet-grid";
import { type DateStr, addDays, todayInTokyo } from "../../shared/date";
import { describeRule, shortDate } from "../../shared/describe";
import { evaluate } from "../../shared/schedule";
import { parseDateText, parseScheduleText } from "../../shared/schedule-text";
import type { ChoreTemplate } from "../../shared/templates";
import { ApiError, type Family, type Group, type Member, api } from "../api";
import { ROW_HEIGHT, type SheetCol, SheetCtx, type SheetCtxValue, norm, useSheet } from "../components/Sheet";
import { TemplateDialog } from "../components/TemplateDialog";
import { errorText } from "../format";
import type { Nav } from "../router";
import type { BulkData } from "./ChoreBulk";

type GridRow = { id: string; name: string; group: string; schedule: string; due: string; assignee: string };
type Field = Exclude<keyof GridRow, "id">;

/** 列の並び（col の番号はこの順） */
const COLS: (SheetCol & { field: Field })[] = [
  { field: "name", title: "家事の名前", placeholder: "例：シンクの排水口", basis: 240, grow: 2, minWidth: 180 },
  { field: "group", title: "グループ", picker: "list", basis: 140 },
  { field: "schedule", title: "周期", picker: "schedule", placeholder: "例：7日ごと、毎週 月・木", basis: 180 },
  { field: "due", title: "最初の期限", picker: "date", basis: 180 },
  { field: "assignee", title: "担当", picker: "list", basis: 140 },
];

let seq = 0;
const blankRow = (patch: Partial<GridRow> = {}): GridRow => ({ id: `r${++seq}`, name: "", group: "", schedule: "", due: "", assignee: "", ...patch });
const isBlank = (r: GridRow) => !r.name.trim();

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

/** PC 幅：エクセルのような表でまとめて登録。名前が空の行は登録しない */
export function ChoreBulkGrid({ family, nav, data: { groups, members, existing } }: { family: Family; nav: Nav; data: BulkData }) {
  const today = todayInTokyo();
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checksRef = useRef(new Map<string, Checked>());
  const sheet = useSheet<GridRow>({
    cols: COLS,
    initial: () => Array.from({ length: 5 }, () => blankRow()),
    // 最後の行に名前が入ったら、空の行を1つ足す（表に書き足していく感覚で）
    normalize: (next) => (next.length === 0 || !isBlank(next[next.length - 1]!) ? [...next, blankRow()] : next),
    onCommit: (prevRows, next) => {
      const prev = new Map(prevRows.map((r) => [r.id, r]));
      setRowErrors((errs) => Object.fromEntries(Object.entries(errs).filter(([id]) => prev.get(id) === next.find((r) => r.id === id))));
    },
    // カレンダー固定（毎週・毎月）の行は、最初の期限が要らない
    disabled: (field, r) => field === "due" && !!checksRef.current.get(r.id)?.dueDisabled,
  });
  const { rows, commit, undo } = sheet;

  const checks = useMemo(() => new Map(rows.map((r) => [r.id, checkRow(r, today, groups, members)])), [rows, today, groups, members]);
  checksRef.current = checks;

  const ctx: SheetCtxValue = {
    today,
    cellOf: (r, field, disabled) => {
      const check = checks.get(r.id);
      const error = check?.errors[field as Field];
      const out = { error, rowError: rowErrors[r.id] };
      if (field !== "due") return out;
      const hint = <span className="bulk-grid__hint">{check?.dueHint ?? (disabled ? "—" : undefined)}</span>;
      if (disabled || !r.due) return { ...out, shown: hint };
      return error ? out : { ...out, shown: shortDate(parseDateText(r.due, today)!) };
    },
    options: (field) => (field === "group" ? groups.map((g) => g.name) : members.map((m) => m.displayName)),
    pick: sheet.pick,
    moveTo: sheet.moveTo,
  };

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

      <SheetCtx.Provider value={ctx}>
        <div className="bulk-grid">
          <DataSheetGrid<GridRow>
            {...sheet.gridProps}
            createRow={() => blankRow()}
            duplicateRow={({ rowData }) => ({ ...rowData, id: blankRow().id })}
            height={ROW_HEIGHT * 16}
            addRowsComponent={false}
          />
        </div>
      </SheetCtx.Provider>

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
            sheet.gridRef.current?.setActiveCell({ row: rows.length, col: 0 });
          }}
        >
          行を足す
        </button>
        <button className="btn btn--quiet" disabled={!sheet.canUndo} onClick={undo}>
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
