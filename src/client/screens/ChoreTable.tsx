// 家事を表で編集（PC 幅）。表の部品は components/Sheet。上に登録済みの家事（無効のものも）、その下に新しい行。
// 登録済みの行は変えたマスに印を付けて変えた項目だけを、新しい行は名前のあるものを、「削除」にチェックした行は確かめてから、
// PATCH /families/:fid/chores/bulk の1回（create・chores・deleteIds）でまとめて保存する。スマホ幅では1行ずつ足す画面。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type CellProps, DataSheetGrid } from "react-datasheet-grid";
import { type DateStr, addDays, todayInTokyo, toDayNum } from "../../shared/date";
import { describeRule, shortDate } from "../../shared/describe";
import { type CalendarRule, type Schedule, evaluate, isOccurrence } from "../../shared/schedule";
import { formatScheduleText, parseDateText, parseScheduleText } from "../../shared/schedule-text";
import type { ChoreTemplate } from "../../shared/templates";
import { ApiError, type Family, type Group, type Member, api } from "../api";
import type { ChoreView } from "../chores";
import { HOWTO_MAX, howtoLength } from "../components/Howto";
import { CHECKED, ContextMenu, ROW_HEIGHT, type SheetCol, SheetCtx, type SheetCtxValue, norm, useSheet } from "../components/Sheet";
import { TemplateDialog, useModal } from "../components/TemplateDialog";
import { errorText } from "../format";
import { type Nav, setLeaveGuard } from "../router";
import { ChoreBulk, useWide } from "./ChoreBulk";
import { TIMES } from "./ChoreForm";

type EditRow = {
  id: string;
  group: string;
  name: string;
  schedule: string;
  due: string;
  assignee: string;
  notify: string;
  howto: string;
  archived: string;
  delete: string;
};
type Field = Exclude<keyof EditRow, "id">;

/** 列の並び（col の番号はこの順） */
const COLS: (SheetCol & { field: Field })[] = [
  { field: "group", title: "グループ", picker: "list", basis: 130 },
  { field: "name", title: "家事の名前", placeholder: "例：シンクの排水口", basis: 220, grow: 2, minWidth: 160 },
  { field: "schedule", title: "周期", picker: "schedule", placeholder: "例：7日ごと、毎週 月・木", basis: 170 },
  { field: "due", title: "期限", picker: "date", basis: 150 },
  { field: "assignee", title: "担当", picker: "list", basis: 130 },
  { field: "notify", title: "通知の時刻", picker: "list", basis: 120, minWidth: 100 },
  { field: "howto", title: "やり方", picker: "markdown", basis: 90, grow: 0, minWidth: 90 },
  { field: "archived", title: "無効", picker: "check", basis: 80, grow: 0, minWidth: 80 },
  { field: "delete", title: "削除", picker: "check", basis: 80, grow: 0, minWidth: 80 },
];
const NAME_COL = COLS.findIndex((c) => c.field === "name");
/** 「行をまとめて追加」で一度に足せる行の数 */
const ADD_MAX = 100;

type Data = { today: DateStr; chores: ChoreView[]; groups: Group[]; members: Member[] };
/** 「保存して編集を続ける」で表を作り直すときに引き継ぐもの */
type Keep = { notice: string; windowY: number; gridY: number; cell: { rowId: string; row: number; col: number } | null };

let seq = 0;
const NEW = "new-";
const isNew = (r: EditRow) => r.id.startsWith(NEW);
const blankRow = (patch: Partial<EditRow> = {}): EditRow => ({
  id: `${NEW}${++seq}`,
  group: "",
  name: "",
  schedule: "",
  due: "",
  assignee: "",
  notify: "",
  howto: "",
  archived: "",
  delete: "",
  ...patch,
});
/** 名前が空の新しい行（保存しない） */
const isBlankNew = (r: EditRow) => isNew(r) && !r.name.trim();

/** 登録済みの行を上、新しい行を下に並べ、最後にいつも空の行を1つ置く */
function normalize(rows: EditRow[]): EditRow[] {
  const out = [...rows.filter((r) => !isNew(r)), ...rows.filter(isNew)];
  const last = out[out.length - 1];
  return last && isBlankNew(last) ? out : [...out, blankRow()];
}

const everyOf = (s: Schedule) => (s.type === "calendar" ? s.rule.every : 1);

/** 家事を表の1行にする。次の期限は、日数の周期と隔週・数か月ごと（基準日の要るもの）だけ持つ */
function rowOf(c: ChoreView): EditRow {
  const s = c.schedule;
  const due = s.type === "interval" ? (c.dueOn ?? s.firstDueOn) : everyOf(s) >= 2 ? (c.dueOn ?? s.rule.anchor) : "";
  return {
    id: c.id,
    group: c.groupName ?? "",
    name: c.name,
    schedule: formatScheduleText(s),
    due,
    assignee: c.assigneeName ?? "",
    notify: c.notifyTime ?? "",
    howto: c.howto ?? "",
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

/** 名前の文字を id にする。空・「なし」は null、見つからなければ undefined */
function lookup<T>(text: string, list: T[], nameOf: (t: T) => string, idOf: (t: T) => string) {
  const t = norm(text);
  if (t === "" || t === "なし") return null;
  const hit = list.find((x) => norm(nameOf(x)) === t);
  return hit ? idOf(hit) : undefined;
}

/** 1行を読んだ結果 */
type Checked = {
  errors: Partial<Record<Field, string>>;
  /** 元から変わったマス（登録済みの行だけ） */
  changed: Set<Field>;
  /** 期限のマスに薄く出す日付 */
  dueHint?: string;
  /** 毎週・毎月は期限を選べない（周期から決まる） */
  dueDisabled: boolean;
  /** 送る中身（登録済みの行は変えた項目だけ）。不備があれば・送るものが無ければ無い */
  payload?: Record<string, unknown>;
};

type Refs = { today: DateStr; groups: Group[]; members: Member[] };

/** グループ・担当・通知・名前のマスを読む（新しい行と登録済みの行で同じ） */
function readCommon(r: EditRow, { groups, members }: Refs) {
  const errors: Checked["errors"] = {};
  const name = r.name.trim();
  if (!name) errors.name = "名前を入れてください";
  else if ([...name].length > 40) errors.name = "名前は40字までです";
  const groupId = lookup(r.group, groups, (g) => g.name, (g) => g.id);
  if (groupId === undefined) errors.group = `「${r.group.trim()}」というグループはありません`;
  const assigneeUserId = lookup(r.assignee, members, (m) => m.displayName, (m) => m.userId);
  if (assigneeUserId === undefined) errors.assignee = `「${r.assignee.trim()}」という人は Family にいません`;
  const notifyTime = parseNotify(r.notify);
  if (notifyTime === undefined) errors.notify = `「${r.notify.trim()}」は時刻として読めません（15 分きざみ、例 07:00）`;
  const howto = r.howto.trim() ? r.howto : null;
  if (howto && howtoLength(howto) > HOWTO_MAX) errors.howto = `やり方は${HOWTO_MAX}文字までです`;
  return { errors, name, groupId, assigneeUserId, notifyTime, howto };
}

/** 新しい行。期限は最初の期限（まとめて登録と同じ扱い） */
function checkNew(r: EditRow, refs: Refs): Checked {
  const { today } = refs;
  const { errors, name, groupId, assigneeUserId, notifyTime, howto } = readCommon(r, refs);
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
    const next = evaluate({ type: "calendar", rule: { ...p.rule, anchor: today } as CalendarRule }, [], today).dueOn;
    dueHint = next ? `次は ${shortDate(next)}` : undefined;
    schedule = { type: "calendar", rule: p.rule };
  } else {
    dueHint = p.suggestedAnchor ? shortDate(p.suggestedAnchor) : undefined;
    schedule = { type: "calendar", rule: { ...p.rule, anchor: due ?? p.suggestedAnchor ?? today } };
  }

  if (!name) return { errors: {}, changed: new Set(), dueHint, dueDisabled };
  const ok = Object.keys(errors).length === 0;
  return { errors, changed: new Set(), dueHint, dueDisabled, payload: ok ? { name, groupId, assigneeUserId, notifyTime, schedule, howto } : undefined };
}

/** 登録済みの行。期限は次の期限。変えた項目だけを送る */
function checkExisting(r: EditRow, orig: EditRow, chore: ChoreView, refs: Refs): Checked {
  const { today } = refs;
  const common = readCommon(r, refs);
  const errors = common.errors;
  const changed = new Set<Field>();
  const payload: Record<string, unknown> = { id: r.id };
  // 変えていないマスの不備は出さない（元のままなら直せないこともあるので）
  if (common.name !== orig.name) {
    changed.add("name");
    payload.name = common.name;
  }
  if (norm(r.group) !== norm(orig.group)) {
    changed.add("group");
    payload.groupId = common.groupId;
  } else delete errors.group;
  if (norm(r.assignee) !== norm(orig.assignee)) {
    changed.add("assignee");
    payload.assigneeUserId = common.assigneeUserId;
  } else delete errors.assignee;
  if (common.notifyTime !== undefined && common.notifyTime !== (orig.notify || null)) {
    changed.add("notify");
    payload.notifyTime = common.notifyTime;
  } else if (common.notifyTime === undefined) changed.add("notify");
  if ((common.howto ?? "") !== (orig.howto.trim() ? orig.howto : "")) {
    changed.add("howto");
    payload.howto = common.howto;
  } else delete errors.howto;
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

/** 家事を表で編集。PC 幅では表、スマホ幅では1行ずつ足す画面 */
export function ChoreTable({ family, nav }: { family: Family; nav: Nav }) {
  const wide = useWide();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 表を作り直すたびに増やす（ChoreTableGrid の key） */
  const [version, setVersion] = useState(0);
  const [keep, setKeep] = useState<Keep | null>(null);

  const fetchData = useCallback(async (): Promise<Data> => {
    const [d, groups, members] = await Promise.all([
      api<{ today: DateStr; chores: ChoreView[] }>("GET", `/families/${family.id}/chores?archived=1`),
      api<Group[]>("GET", `/families/${family.id}/groups`),
      api<Member[]>("GET", `/families/${family.id}/members`),
    ]);
    return { ...d, groups, members };
  }, [family.id]);
  const load = useCallback(async () => {
    try {
      setData(await fetchData());
    } catch (e) {
      setError(errorText(e));
    }
  }, [fetchData]);

  /** 保存できたあと画面に残る：読み直して表を作り直す（データと key を同時に変える）。読めなければ一覧へ */
  const reload = async (k: Keep) => {
    try {
      const d = await fetchData();
      setData(d);
      setKeep(k);
      setVersion((v) => v + 1);
    } catch {
      sessionStorage.setItem("kaji.flash", k.notice);
      nav.go({ name: "chores" });
    }
  };
  useEffect(() => {
    if (wide) void load();
  }, [load, wide]);

  if (!wide) return <ChoreBulk family={family} nav={nav} />;

  return (
    <main className="page page--wide">
      <div className="page-head">
        <h1>家事を表で編集</h1>
        <button className="btn btn--quiet" onClick={() => nav.back({ name: "chores" })}>
          家事の一覧へ
        </button>
      </div>
      <p className="muted">
        登録した家事を直し、下の新しい行（「新」の印）に書いて家事を足し、まとめて保存します。名前が空の新しい行は保存しません。Excel
        やスプレッドシートから貼り付けもできます。範囲を選んで打ち、Ctrl（⌘）+Enter で範囲の全部に同じ値が入ります。期限は、登録済みの家事では次の期限、新しい行では最初の期限です（毎週・毎月は周期から決まります）。「削除」にチェックした家事は、保存すると記録ごと消えます（残したいときは「無効」に）。
      </p>
      {error && !data && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!data ? !error && <p aria-busy="true">読み込んでいます…</p> : <ChoreTableGrid key={version} family={family} nav={nav} data={data} keep={keep} onSavedContinue={reload} />}
    </main>
  );
}

/** 左端の行番号。新しい行は「新」 */
function Gutter({ rowData, rowIndex }: CellProps<EditRow, unknown>) {
  return isNew(rowData) ? (
    <span className="bulk-grid__new" title={`${rowIndex + 1}行目（新しい行）`} data-gutter={rowIndex + 1}>
      新
    </span>
  ) : (
    <span data-gutter={rowIndex + 1}>{rowIndex + 1}</span>
  );
}

function ChoreTableGrid({
  family,
  nav,
  data,
  keep,
  onSavedContinue,
}: {
  family: Family;
  nav: Nav;
  data: Data;
  keep: Keep | null;
  onSavedContinue: (k: Keep) => Promise<void>;
}) {
  const { groups, members } = data;
  const today = todayInTokyo();
  const refs: Refs = useMemo(() => ({ today, groups, members }), [today, groups, members]);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(keep?.notice ?? null);

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
  const existingNames = useMemo(() => data.chores.map((c) => c.name), [data]);

  const checksRef = useRef(new Map<string, Checked>());
  const sheet = useSheet<EditRow>({
    cols: COLS,
    initial: () => normalize(initial),
    normalize,
    onCommit: (prevRows, next) => {
      const prev = new Map(prevRows.map((r) => [r.id, r]));
      setRowErrors((errs) => Object.fromEntries(Object.entries(errs).filter(([id]) => prev.get(id) === next.find((r) => r.id === id))));
    },
    disabled: (field, r) => ((field === "archived" || field === "delete") && isNew(r)) || (field === "due" && !!checksRef.current.get(r.id)?.dueDisabled),
  });
  const { rows, commit, undo } = sheet;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  /** 最後に選んでいたマス（ボタンを押すと表の選択は外れるので覚えておく） */
  const lastCellRef = useRef<Keep["cell"]>(null);
  /** 選んでいたマスに戻したとき（次の1回は、最後の行でも空の行を足さない） */
  const restoringRef = useRef(false);

  // 作り直した表では、前のスクロールの位置と選んでいたマスに戻す（行は同じ家事があればその行、無ければ同じ番号の行）
  useEffect(() => {
    if (!keep) return;
    scrollTo({ top: keep.windowY });
    requestAnimationFrame(() => {
      const scroller = document.querySelector<HTMLElement>(".bulk-grid .dsg-container");
      if (scroller) scroller.scrollTop = keep.gridY;
      const c = keep.cell;
      if (!c) return;
      const cur = rowsRef.current;
      const i = cur.findIndex((r) => r.id === c.rowId);
      restoringRef.current = true;
      sheet.gridRef.current?.setActiveCell({ row: i >= 0 ? i : Math.min(c.row, cur.length - 1), col: c.col });
      requestAnimationFrame(() => {
        if (scroller) scroller.scrollTop = keep.gridY;
      });
    });
    // 作り直したときに1回だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checks = useMemo(
    () => new Map(rows.map((r) => [r.id, isNew(r) ? checkNew(r, refs) : checkExisting(r, byId.get(r.id)!.orig, byId.get(r.id)!.chore, refs)])),
    [rows, byId, refs],
  );
  checksRef.current = checks;

  // 削除する行は、ほかのマスを変えていても消すだけ（変更としては数えない）
  const deleteRows = rows.filter((r) => !isNew(r) && r.delete);
  const changedRows = rows.filter((r) => !isNew(r) && !r.delete && checks.get(r.id)!.changed.size > 0);
  const createRows = rows.filter((r) => isNew(r) && !isBlankNew(r));
  const invalid = rows.filter((r) => !r.delete && Object.keys(checks.get(r.id)!.errors).length > 0);
  const dirty = changedRows.length > 0 || deleteRows.length > 0 || createRows.length > 0;

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
      if ((f === "archived" || f === "delete") && disabled) return { ...out, shown: <span className="bulk-grid__hint">—</span> };
      if (f === "notify" && !r.notify) return { ...out, shown: <span className="bulk-grid__hint">それぞれ</span> };
      if (f === "group" && !r.group) return { ...out, shown: <span className="bulk-grid__hint">なし</span> };
      if (f === "assignee" && !r.assignee) return { ...out, shown: <span className="bulk-grid__hint">なし</span> };
      if (f === "howto") return { ...out, shown: r.howto?.trim() ? "あり" : <span className="bulk-grid__hint">—</span> };
      if (f !== "due") return out;
      const hint = <span className="bulk-grid__hint">{check?.dueHint ?? (disabled ? "—" : undefined)}</span>;
      if (disabled || !r.due) return { ...out, shown: hint };
      return error ? out : { ...out, shown: shortDate(parseDateText(r.due, today)!) };
    },
    options: (field) => (field === "group" ? groups.map((g) => g.name) : field === "assignee" ? members.map((m) => m.displayName) : TIMES),
    pick: sheet.pick,
    moveTo: sheet.moveTo,
  };

  /** 新しい行を末尾に足す（空の行の前に置かず、最後の空の行のあとに続ける） */
  const appendBlank = (n: number) => {
    const start = rows.length;
    commit([...rows, ...Array.from({ length: n }, () => blankRow())]);
    // 表を描き直してから、最初に足した行の名前のマスへ
    requestAnimationFrame(() => sheet.gridRef.current?.setActiveCell({ row: start, col: NAME_COL }));
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
    commit([...rows.filter((r) => !isBlankNew(r)), ...added]);
    setPicking(false);
  };

  const badRows = [...createRows, ...changedRows].filter((r) => !checks.get(r.id)!.payload);

  /** stay：保存できたら画面に残って表を読み直す。でなければ一覧へ */
  const save = async (stay: boolean) => {
    setError(null);
    setNotice(null);
    if (badRows.length) {
      setError(`赤いマスを直してください（${badRows.length}行）`);
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
      const res = await api<{ created: number; updated: number; deleted: number }>("PATCH", `/families/${family.id}/chores/bulk`, {
        create: createRows.map((r) => checks.get(r.id)!.payload),
        chores: changedRows.map((r) => checks.get(r.id)!.payload),
        deleteIds: deleteRows.map((r) => r.id),
      });
      setLeaveGuard(null);
      const parts = [res.created && `${res.created}件を追加`, res.updated && `${res.updated}件を変更`, res.deleted && `${res.deleted}件を削除`].filter(Boolean);
      const message = `${parts.join("・")}しました`;
      if (stay) {
        await onSavedContinue({
          notice: message,
          windowY: scrollY,
          gridY: document.querySelector(".bulk-grid .dsg-container")?.scrollTop ?? 0,
          cell: lastCellRef.current,
        });
        return;
      }
      sessionStorage.setItem("kaji.flash", message);
      nav.go({ name: "chores" });
    } catch (e) {
      if (e instanceof ApiError && e.code === "bulk_invalid" && e.detail?.rows) {
        const map: Record<string, string> = {};
        const lists = { create: createRows, update: changedRows, delete: deleteRows };
        for (const { index, message, kind } of e.detail.rows as { index: number; message: string; kind: keyof typeof lists }[]) {
          const r = lists[kind]?.[index];
          if (r) map[r.id] = message;
        }
        setRowErrors(map);
      }
      setError(errorText(e));
      setBusy(false);
    }
  };

  // 表の下に出す、行ごとの直すところ・注意
  const notes = rows.flatMap((r, i) => {
    if (isBlankNew(r)) return [];
    const out: { key: string; text: string; error: boolean }[] = [];
    const errs = r.delete ? {} : (checks.get(r.id)?.errors ?? {});
    const label = `${i + 1}行目（${r.name.trim() || "名前なし"}）`;
    for (const c of COLS) if (errs[c.field]) out.push({ key: `${r.id}-${c.field}`, text: `${label}・${c.title}：${errs[c.field]}`, error: true });
    if (rowErrors[r.id]) out.push({ key: `${r.id}-server`, text: `${label}：${rowErrors[r.id]}`, error: true });
    if (isNew(r) && existingNames.includes(r.name.trim())) out.push({ key: `${r.id}-dup`, text: `${label}：同じ名前の家事が、もうあります`, error: false });
    return out;
  });

  const label = !dirty
    ? "変更はありません"
    : [createRows.length && `${createRows.length}件の追加`, changedRows.length && `${changedRows.length}件の変更`, deleteRows.length && `${deleteRows.length}件の削除`]
        .filter(Boolean)
        .join("・") + "を保存";

  return (
    <>
      <div className="form-actions bulk-actions">
        <button className="btn" onClick={() => setAdding(true)}>
          行をまとめて追加
        </button>
        <button className="btn" onClick={() => setPicking(true)}>
          よくある家事から選ぶ
        </button>
      </div>
      {notice && (
        <p className="notice notice--ok" role="status">
          {notice}
        </p>
      )}
      <SheetCtx.Provider value={ctx}>
        <div className="bulk-grid">
          <DataSheetGrid<EditRow>
            {...sheet.gridProps}
            gutterColumn={{ component: Gutter, basis: 44, minWidth: 44 }}
            rowClassName={({ rowData }) => (rowData.delete ? "is-deleted" : isNew(rowData) ? "is-new" : undefined)}
            contextMenuComponent={(p) => {
              // 登録済みの行は表から消さない（「削除」の列で消す）。行は登録済みの下に足す
              const old = (row: number) => !!rowsRef.current[row] && !isNew(rowsRef.current[row]!);
              const items = p.items.filter((it) => {
                if (it.type === "DELETE_ROW" || it.type === "INSERT_ROW_BELLOW") return !old(p.cursorIndex.row);
                if (it.type === "DELETE_ROWS") return !Array.from({ length: it.toRow - it.fromRow + 1 }, (_, i) => it.fromRow - 1 + i).some(old);
                return true;
              });
              return <ContextMenu {...p} items={items} />;
            }}
            createRow={() => blankRow()}
            duplicateRow={({ rowData: { id: _, ...rest } }) => blankRow({ ...rest, archived: "", delete: "" })}
            disableSmartDelete
            onActiveCellChange={({ cell }) => {
              // カーソルが最後の行に入ったら、空の行をもう1つ足す
              const cur = rowsRef.current;
              if (cell) lastCellRef.current = { rowId: cur[cell.row]?.id ?? "", row: cell.row, col: cell.col };
              if (restoringRef.current) restoringRef.current = false;
              else if (cell && cell.row >= cur.length - 1) sheet.extend([...cur, blankRow()]);
            }}
            height={ROW_HEIGHT * Math.min(rows.length + 1, 16) + 2}
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
        <button className="btn btn--primary" disabled={busy || !dirty} onClick={() => void save(false)}>
          {label}
        </button>
        <button className="btn" disabled={busy || !dirty} onClick={() => void save(true)}>
          保存して編集を続ける
        </button>
        <button className="btn btn--quiet" disabled={!sheet.canUndo} onClick={undo}>
          元に戻す
        </button>
        {invalid.length > 0 && <span className="error">赤いマスが {invalid.length}行にあります</span>}
      </div>

      {adding && (
        <AddRowsDialog
          onCancel={() => setAdding(false)}
          onAdd={(n) => {
            setAdding(false);
            appendBlank(n);
          }}
        />
      )}
      {picking && (
        <TemplateDialog existing={[...existingNames, ...createRows.map((r) => r.name.trim())]} onCancel={() => setPicking(false)} onAdd={addTemplates} />
      )}
    </>
  );
}

/** 足す行の数を聞く小さな画面。Enter で追加、Esc でやめる */
function AddRowsDialog({ onAdd, onCancel }: { onAdd: (n: number) => void; onCancel: () => void }) {
  const [text, setText] = useState("5");
  const { ref } = useModal(onCancel);
  const n = Number(text);
  const ok = Number.isInteger(n) && n >= 1 && n <= ADD_MAX;
  return (
    <dialog ref={ref} className="dialog" onClose={onCancel} aria-labelledby="add-rows-title">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onAdd(n);
        }}
      >
        <h2 id="add-rows-title">行をまとめて追加</h2>
        <label className="field field--short">
          <span>足す行の数（1〜{ADD_MAX}）</span>
          <input type="number" min={1} max={ADD_MAX} value={text} onChange={(e) => setText(e.target.value)} autoFocus onFocus={(e) => e.target.select()} />
        </label>
        {!ok && <p className="error">1〜{ADD_MAX}の数を入れてください</p>}
        <div className="form-actions">
          <button type="submit" className="btn btn--primary" disabled={!ok}>
            追加
          </button>
          <button type="button" className="btn btn--quiet" onClick={() => ref.current?.close()}>
            やめる
          </button>
        </div>
      </form>
    </dialog>
  );
}
