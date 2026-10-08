// 登録済みの家事を表でまとめて直す（PC 幅）。表の部品は components/Sheet。
// 行は全部の家事（無効のものも）。変えたマスに印を付け、変えた行の変えた項目だけを PATCH /families/:fid/chores/bulk で送る。
// 「削除」にチェックした行は、確かめてから deleteIds で一緒に送る（ほかのマスの変更は送らない）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataSheetGrid } from "react-datasheet-grid";
import { type DateStr, todayInTokyo, toDayNum } from "../../shared/date";
import { shortDate } from "../../shared/describe";
import { type CalendarRule, type Schedule, evaluate, isOccurrence } from "../../shared/schedule";
import { formatScheduleText, parseDateText, parseScheduleText } from "../../shared/schedule-text";
import { ApiError, type Family, type Group, type Member, api } from "../api";
import type { ChoreView } from "../chores";
import { CHECKED, ROW_HEIGHT, type SheetCol, SheetCtx, type SheetCtxValue, norm, useSheet } from "../components/Sheet";
import { errorText } from "../format";
import { type Nav, setLeaveGuard } from "../router";
import { useWide } from "./ChoreBulk";
import { TIMES } from "./ChoreForm";

type EditRow = { id: string; name: string; group: string; schedule: string; due: string; assignee: string; notify: string; archived: string; delete: string };
type Field = Exclude<keyof EditRow, "id">;

/** 列の並び（col の番号はこの順） */
const COLS: (SheetCol & { field: Field })[] = [
  { field: "name", title: "家事の名前", basis: 220, grow: 2, minWidth: 160 },
  { field: "group", title: "グループ", picker: "list", basis: 130 },
  { field: "schedule", title: "周期", picker: "schedule", placeholder: "例：7日ごと、毎週 月・木", basis: 170 },
  { field: "due", title: "次の期限", picker: "date", basis: 150 },
  { field: "assignee", title: "担当", picker: "list", basis: 130 },
  { field: "notify", title: "通知の時刻", picker: "list", basis: 120, minWidth: 100 },
  { field: "archived", title: "無効", picker: "check", basis: 80, grow: 0, minWidth: 80 },
  { field: "delete", title: "削除", picker: "check", basis: 80, grow: 0, minWidth: 80 },
];

type Data = { today: DateStr; chores: ChoreView[]; groups: Group[]; members: Member[] };

const everyOf = (s: Schedule) => (s.type === "calendar" ? s.rule.every : 1);

/** 家事を表の1行にする。次の期限は、日数の周期と隔週・数か月ごと（基準日の要るもの）だけ持つ */
function rowOf(c: ChoreView): EditRow {
  const s = c.schedule;
  const due = s.type === "interval" ? (c.dueOn ?? s.firstDueOn) : everyOf(s) >= 2 ? (c.dueOn ?? s.rule.anchor) : "";
  return {
    id: c.id,
    name: c.name,
    group: c.groupName ?? "",
    schedule: formatScheduleText(s),
    due,
    assignee: c.assigneeName ?? "",
    notify: c.notifyTime ?? "",
    archived: c.archived ? CHECKED : "",
    delete: "",
  };
}

/** 通知の時刻の文字を読む。空・「なし」は null、読めなければ undefined */
function parseNotify(text: string): string | null | undefined {
  const t = norm(text);
  if (t === "" || t === "なし") return null;
  const m = /^(\d{1,2})[:：時](\d{2})?分?$/.exec(t);
  if (!m) return undefined;
  const v = `${m[1]!.padStart(2, "0")}:${m[2] ?? "00"}`;
  return TIMES.includes(v) ? v : undefined;
}

/** 1行を読んだ結果 */
type Checked = {
  errors: Partial<Record<Field, string>>;
  /** 元から変わったマス */
  changed: Set<Field>;
  /** 次の期限のマスに薄く出す日付 */
  dueHint?: string;
  /** 毎週・毎月は次の期限を選べない（周期から決まる） */
  dueDisabled: boolean;
  /** 送る中身（変えた項目だけ）。不備があれば無い */
  payload?: Record<string, unknown>;
};

function checkRow(r: EditRow, orig: EditRow, chore: ChoreView, today: DateStr, groups: Group[], members: Member[]): Checked {
  const errors: Checked["errors"] = {};
  const changed = new Set<Field>();
  const payload: Record<string, unknown> = { id: r.id };
  /** 名前の文字を id にする。空・「なし」は null、見つからなければ undefined */
  const lookup = <T,>(text: string, list: T[], nameOf: (t: T) => string, idOf: (t: T) => string) => {
    const t = norm(text);
    if (t === "" || t === "なし") return null;
    const hit = list.find((x) => norm(nameOf(x)) === t);
    return hit ? idOf(hit) : undefined;
  };

  const name = r.name.trim();
  if (!name) errors.name = "名前を入れてください";
  else if ([...name].length > 40) errors.name = "名前は40字までです";
  if (name !== orig.name) {
    changed.add("name");
    payload.name = name;
  }

  if (norm(r.group) !== norm(orig.group)) {
    changed.add("group");
    const groupId = lookup(r.group, groups, (g) => g.name, (g) => g.id);
    if (groupId === undefined) errors.group = `「${r.group.trim()}」というグループはありません`;
    payload.groupId = groupId;
  }
  if (norm(r.assignee) !== norm(orig.assignee)) {
    changed.add("assignee");
    const userId = lookup(r.assignee, members, (m) => m.displayName, (m) => m.userId);
    if (userId === undefined) errors.assignee = `「${r.assignee.trim()}」という人は Family にいません`;
    payload.assigneeUserId = userId;
  }
  const notify = parseNotify(r.notify);
  if (notify === undefined) errors.notify = `「${r.notify.trim()}」は時刻として読めません（15 分きざみ、例 07:00）`;
  if (notify !== (orig.notify || null)) {
    changed.add("notify");
    payload.notifyTime = notify;
  }
  if (!!r.archived !== !!orig.archived) {
    changed.add("archived");
    payload.archived = !!r.archived;
  }

  // 周期と次の期限。変えたときだけ周期を送る（毎週・毎月は基準日を送らず、サーバで前の基準日を引き継ぐ）
  const dueText = r.due.trim();
  const due = dueText ? parseDateText(dueText, today) : null;
  const dueChanged = dueText !== orig.due.trim();
  let dueHint: string | undefined;
  let dueDisabled = false;
  const p = parseScheduleText(r.schedule, today);
  if (!p.ok) {
    errors.schedule = p.message;
    if (norm(r.schedule) !== norm(orig.schedule)) changed.add("schedule");
  } else {
    let schedule: Schedule;
    /** 送る周期。毎週・毎月は基準日を入れない */
    let send: unknown;
    if (p.kind === "interval") {
      dueHint = `今日 ${shortDate(today)}`;
      schedule = { type: "interval", intervalDays: p.intervalDays, firstDueOn: due ?? today };
      send = schedule;
    } else if (!p.needsAnchor) {
      dueDisabled = true;
      const rule = { ...p.rule, anchor: chore.schedule.type === "calendar" ? chore.schedule.rule.anchor : today } as CalendarRule;
      schedule = { type: "calendar", rule };
      send = { type: "calendar", rule: p.rule };
      // 周期を変えていなければ今の次の期限、変えたら記録なしで数えた次の予定日
      const next = formatScheduleText(schedule) === orig.schedule ? chore.dueOn : evaluate(schedule, [], today).dueOn;
      dueHint = next ? `次は ${shortDate(next)}` : undefined;
    } else {
      // 隔週・数か月ごと：次の期限を基準日にする。変えていない期限が新しい周期に当たらなければ、当たる日にずらす
      const fits = (d: DateStr | null) => !!d && isOccurrence({ ...p.rule, anchor: d } as CalendarRule, toDayNum(d));
      const anchor = dueChanged ? due : fits(due) ? due : (p.suggestedAnchor ?? today);
      if (dueChanged && due && !fits(due)) errors.due = "選んだ曜日・日に当たる日にしてください";
      dueHint = p.suggestedAnchor ? shortDate(p.suggestedAnchor) : undefined;
      schedule = { type: "calendar", rule: { ...p.rule, anchor: anchor ?? p.suggestedAnchor ?? today } as CalendarRule };
      send = schedule;
    }
    const scheduleChanged = formatScheduleText(schedule) !== orig.schedule;
    if (scheduleChanged) changed.add("schedule");
    if (!dueDisabled && dueChanged) changed.add("due");
    if (scheduleChanged || (!dueDisabled && dueChanged)) payload.schedule = send;
  }
  if (!dueDisabled && dueText && !due) errors.due = `「${dueText}」は日付として読めません（例：2026-10-20、10/20）`;

  const ok = Object.keys(errors).length === 0;
  return { errors, changed, dueHint, dueDisabled, payload: ok && changed.size > 0 ? payload : undefined };
}

const LEAVE_MESSAGE = "保存していない変更があります。この画面を離れると消えます。よろしいですか？";

/** 表で直す。PC 幅では表、スマホ幅では案内だけ */
export function ChoreTable({ family, nav }: { family: Family; nav: Nav }) {
  const wide = useWide();
  const [data, setData] = useState<Data | null>(null);
  const [version, setVersion] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, groups, members] = await Promise.all([
        api<{ today: DateStr; chores: ChoreView[] }>("GET", `/families/${family.id}/chores?archived=1`),
        api<Group[]>("GET", `/families/${family.id}/groups`),
        api<Member[]>("GET", `/families/${family.id}/members`),
      ]);
      setData({ ...d, groups, members });
      setVersion((v) => v + 1);
    } catch (e) {
      setError(errorText(e));
    }
  }, [family.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const toList = (
    <button className="btn btn--quiet" onClick={() => nav.go({ name: "chores" })}>
      家事の一覧へ
    </button>
  );

  if (!wide)
    return (
      <main className="page">
        <h1>表で直す</h1>
        <p className="notice">表で直すのは PC で（画面の広いところで）開いてください。スマホでは、家事の詳細から1つずつ直せます。</p>
        {toList}
      </main>
    );

  return (
    <main className="page page--wide">
      <div className="page-head">
        <h1>表で直す</h1>
        {toList}
      </div>
      <p className="muted">
        登録した家事を表でまとめて直します。変えたマスには印が付き、「保存」で変えた行だけが保存されます。範囲を選んで打ち、Ctrl（⌘）+Enter
        で範囲の全部に同じ値が入ります。次の期限は、日数の周期と隔週・数か月ごとのときだけ変えられます。行の追加は「まとめて登録」から。「削除」にチェックした家事は、保存すると記録ごと消えます（残したいときは「無効」に）。
      </p>
      {flash && (
        <p className="notice notice--ok" role="status">
          {flash}
        </p>
      )}
      {error && !data && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        !error && <p aria-busy="true">読み込んでいます…</p>
      ) : data.chores.length === 0 ? (
        <p className="muted">まだ家事がありません。</p>
      ) : (
        <ChoreTableGrid
          key={version}
          family={family}
          data={data}
          onSaved={(updated, deleted) => {
            setFlash([updated && `${updated}件の家事を保存しました`, deleted && `${deleted}件の家事を削除しました`].filter(Boolean).join("。"));
            void load();
          }}
          onEdit={() => setFlash(null)}
        />
      )}
    </main>
  );
}

function ChoreTableGrid({ family, data, onSaved, onEdit }: { family: Family; data: Data; onSaved: (updated: number, deleted: number) => void; onEdit: () => void }) {
  const { groups, members } = data;
  const today = todayInTokyo();
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 無効のものは後ろ、グループの並び順（グループなしは最後）、名前の順
  const { initial, byId } = useMemo(() => {
    const order = new Map(groups.map((g, i) => [g.id, i]));
    const sorted = [...data.chores].sort(
      (a, b) =>
        Number(a.archived) - Number(b.archived) ||
        (order.get(a.groupId ?? "") ?? groups.length) - (order.get(b.groupId ?? "") ?? groups.length) ||
        a.name.localeCompare(b.name, "ja"),
    );
    return { initial: sorted.map(rowOf), byId: new Map(sorted.map((c) => [c.id, { chore: c, orig: rowOf(c) }])) };
  }, [data, groups]);

  const checksRef = useRef(new Map<string, Checked>());
  const sheet = useSheet<EditRow>({
    cols: COLS,
    initial: () => initial,
    onCommit: (prevRows, next) => {
      const prev = new Map(prevRows.map((r) => [r.id, r]));
      setRowErrors((errs) => Object.fromEntries(Object.entries(errs).filter(([id]) => prev.get(id) === next.find((r) => r.id === id))));
      onEdit();
    },
    disabled: (field, r) => field === "due" && !!checksRef.current.get(r.id)?.dueDisabled,
  });
  const { rows, undo } = sheet;

  const checks = useMemo(
    () => new Map(rows.map((r) => [r.id, checkRow(r, byId.get(r.id)!.orig, byId.get(r.id)!.chore, today, groups, members)])),
    [rows, byId, today, groups, members],
  );
  checksRef.current = checks;

  // 削除する行は、ほかのマスを変えていても消すだけ（変更としては数えない）
  const deleteRows = rows.filter((r) => r.delete);
  const changedRows = rows.filter((r) => !r.delete && checks.get(r.id)!.changed.size > 0);
  const invalid = rows.filter((r) => !r.delete && Object.keys(checks.get(r.id)!.errors).length > 0);
  const dirty = changedRows.length > 0 || deleteRows.length > 0;

  // 保存しないで離れようとしたら確かめる（アプリの中の移動・戻る・タブを閉じる・読み直す）
  useEffect(() => {
    if (!dirty) return;
    setLeaveGuard(LEAVE_MESSAGE);
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", onUnload);
    return () => {
      setLeaveGuard(null);
      removeEventListener("beforeunload", onUnload);
    };
  }, [dirty]);

  const ctx: SheetCtxValue = {
    today,
    cellOf: (r, field, disabled) => {
      const check = checks.get(r.id);
      const f = field as Field;
      if (r.delete) {
        // 削除する行は取り消し線だけ。日付は読める形で出す
        const del = { rowError: rowErrors[r.id], changed: f === "delete" };
        const d = f === "due" && r.due ? parseDateText(r.due, today) : null;
        return d ? { ...del, shown: shortDate(d) } : del;
      }
      const error = check?.errors[f];
      const out = { error, rowError: rowErrors[r.id], changed: check?.changed.has(f) };
      if (f === "notify" && !r.notify) return { ...out, shown: <span className="bulk-grid__hint">それぞれ</span> };
      if (f === "group" && !r.group) return { ...out, shown: <span className="bulk-grid__hint">なし</span> };
      if (f === "assignee" && !r.assignee) return { ...out, shown: <span className="bulk-grid__hint">なし</span> };
      if (f !== "due") return out;
      const hint = <span className="bulk-grid__hint">{check?.dueHint ?? (disabled ? "—" : undefined)}</span>;
      if (disabled || !r.due) return { ...out, shown: hint };
      return error ? out : { ...out, shown: shortDate(parseDateText(r.due, today)!) };
    },
    options: (field) => (field === "group" ? groups.map((g) => g.name) : field === "assignee" ? members.map((m) => m.displayName) : TIMES),
    pick: sheet.pick,
    moveTo: sheet.moveTo,
  };

  const badChanged = changedRows.filter((r) => !checks.get(r.id)!.payload);

  const save = async () => {
    setError(null);
    if (badChanged.length) {
      setError(`赤いマスを直してください（${badChanged.length}行）`);
      return;
    }
    if (deleteRows.length) {
      const names = deleteRows.map((r) => `・${byId.get(r.id)!.orig.name}`).join("\n");
      const ok = confirm(`次の${deleteRows.length}件の家事を削除します。\n${names}\n\n記録もすべて消え、元に戻せません。残したいときは『無効』にしてください。`);
      if (!ok) return;
    }
    setBusy(true);
    setRowErrors({});
    try {
      const res = await api<{ updated: number; deleted: number }>("PATCH", `/families/${family.id}/chores/bulk`, {
        chores: changedRows.map((r) => checks.get(r.id)!.payload),
        deleteIds: deleteRows.map((r) => r.id),
      });
      setLeaveGuard(null);
      onSaved(res.updated, res.deleted);
    } catch (e) {
      if (e instanceof ApiError && e.code === "bulk_invalid" && e.detail?.rows) {
        const map: Record<string, string> = {};
        for (const { index, message, kind } of e.detail.rows as { index: number; message: string; kind?: "delete" }[]) {
          const r = (kind === "delete" ? deleteRows : changedRows)[index];
          if (r) map[r.id] = message;
        }
        setRowErrors(map);
      }
      setError(errorText(e));
      setBusy(false);
    }
  };

  // 表の下に出す、行ごとの直すところ
  const notes = rows.flatMap((r, i) => {
    const out: { key: string; text: string }[] = [];
    const errs = r.delete ? {} : (checks.get(r.id)?.errors ?? {});
    for (const c of COLS) if (errs[c.field]) out.push({ key: `${r.id}-${c.field}`, text: `${i + 1}行目（${r.name || "名前なし"}）・${c.title}：${errs[c.field]}` });
    if (rowErrors[r.id]) out.push({ key: `${r.id}-server`, text: `${i + 1}行目（${r.name}）：${rowErrors[r.id]}` });
    return out;
  });

  return (
    <>
      <SheetCtx.Provider value={ctx}>
        <div className="bulk-grid">
          <DataSheetGrid<EditRow>
            {...sheet.gridProps}
            rowClassName={({ rowData }) => (rowData.delete ? "is-deleted" : undefined)}
            lockRows height={ROW_HEIGHT * Math.min(rows.length + 1, 16) + 2} addRowsComponent={false} />
        </div>
      </SheetCtx.Provider>

      {notes.length > 0 && (
        <ul className="bulk-notes">
          {notes.map((n) => (
            <li key={n.key} className="error">
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
        <button className="btn btn--primary" disabled={busy || !dirty} onClick={() => void save()}>
          {!dirty
            ? "変更はありません"
            : deleteRows.length === 0
              ? `${changedRows.length}件の変更を保存`
              : changedRows.length === 0
                ? `${deleteRows.length}件の削除を保存`
                : `${changedRows.length}件の変更・${deleteRows.length}件の削除を保存`}
        </button>
        <button className="btn btn--quiet" disabled={!sheet.canUndo} onClick={undo}>
          元に戻す
        </button>
        {invalid.length > 0 && <span className="error">赤いマスが {invalid.length}行にあります</span>}
      </div>
    </>
  );
}
