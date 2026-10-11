// 一回限りの TODO とサブタスク（1段）。仕様は docs/spec.md「TODO」。
// 家事とちがって周期も記録も無く、統計（分担・守り具合）には入れない
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, max, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { body } from "../auth/routes";
import type { AppEnv, Ctx } from "../context";
import { fail, nowIso, requireAuth } from "../context";
import { validAssignee, validChoreNotify } from "../chores/routes";
import { validGroup } from "../chores/groups";
import { choreGroups, todoSubtasks, todos, users } from "../db/schema";
import { requireMember } from "../families/routes";
import { newId } from "../lib/crypto";
import { type DateStr, diffDays, isDateStr, todayInTokyo } from "../../shared/date";

const MEMO_MAX = 10000;
const SUBTASKS_MAX = 50;
/** 済みの一覧で一度に返す数（新しい順） */
const DONE_LIMIT_DEFAULT = 100;
const DONE_LIMIT_MAX = 500;

type TodoRow = typeof todos.$inferSelect;
type SubtaskRow = typeof todoSubtasks.$inferSelect;

function validTitle(v: unknown, message: string): string {
  const n = typeof v === "string" ? v.trim() : "";
  if ([...n].length < 1 || [...n].length > 60) fail(400, message);
  return n;
}
const validTodoTitle = (v: unknown) => validTitle(v, "TODO の題名を1〜60文字で入れてください");
const validSubtaskTitle = (v: unknown) => validTitle(v, "サブタスクの題名を1〜60文字で入れてください");

/** メモ（Markdown）。家事のやり方と同じ決まり：空なら null、改行は \n にそろえ、HTML はそのまま預かる */
function validMemo(t: unknown): string | null {
  if (t === null || t === undefined) return null;
  if (typeof t !== "string") fail(400, "メモが正しくありません");
  const v = t.replace(/\r\n?/g, "\n");
  if (!v.trim()) return null;
  if ([...v].length > MEMO_MAX) fail(400, `メモは ${MEMO_MAX} 文字までです`);
  return v;
}

function validDueOn(v: unknown): DateStr | null {
  if (v === null || v === undefined || v === "") return null;
  if (!isDateStr(v)) fail(400, "期限を日付で入れてください");
  if (v < "2000-01-01" || v > "2999-12-31") fail(400, "期限の日付が正しくありません");
  return v;
}

function validDone(v: unknown): boolean {
  if (typeof v !== "boolean") fail(400, "済みは true か false です");
  return v;
}

function validSortOrder(v: unknown): number {
  if (!Number.isInteger(v)) fail(400, "並び順は整数です");
  return v as number;
}

/** TODO を引き、その Family のメンバーか確かめる */
async function loadTodo(c: Ctx, id: string) {
  requireAuth(c);
  const todo = await c.get("db").select().from(todos).where(eq(todos.id, id)).get();
  if (!todo) fail(404, "その TODO はありません", "todo_not_found");
  const m = await requireMember(c, todo.familyId).catch(() => fail(404, "その TODO はありません", "todo_not_found"));
  return { todo, userId: m.userId };
}

async function loadSubtask(c: Ctx, id: string) {
  requireAuth(c);
  const row = await c
    .get("db")
    .select({ subtask: todoSubtasks, familyId: todos.familyId })
    .from(todoSubtasks)
    .innerJoin(todos, eq(todoSubtasks.todoId, todos.id))
    .where(eq(todoSubtasks.id, id))
    .get();
  if (!row) fail(404, "そのサブタスクはありません", "subtask_not_found");
  const m = await requireMember(c, row.familyId).catch(() => fail(404, "そのサブタスクはありません", "subtask_not_found"));
  return { subtask: row.subtask, userId: m.userId };
}

const assigneeUser = alias(users, "assignee_user");
const createdUser = alias(users, "created_user");
const doneUser = alias(users, "done_user");

/** TODO を、担当・グループ・作った人・済ませた人の名前つきで引く */
function selectNamed(c: Ctx) {
  return c
    .get("db")
    .select({
      todo: todos,
      assigneeName: assigneeUser.displayName,
      groupName: choreGroups.name,
      createdByName: createdUser.displayName,
      doneByName: doneUser.displayName,
    })
    .from(todos)
    .leftJoin(assigneeUser, eq(todos.assigneeUserId, assigneeUser.id))
    .leftJoin(choreGroups, eq(todos.groupId, choreGroups.id))
    .leftJoin(createdUser, eq(todos.createdBy, createdUser.id))
    .leftJoin(doneUser, eq(todos.doneBy, doneUser.id));
}
type Named = { todo: TodoRow; assigneeName: string | null; groupName: string | null; createdByName: string | null; doneByName: string | null };

const subtaskDoneUser = alias(users, "subtask_done_user");

function subtaskView(s: SubtaskRow, doneByName: string | null) {
  return { id: s.id, todoId: s.todoId, title: s.title, done: !!s.doneAt, doneAt: s.doneAt, doneByName, sortOrder: s.sortOrder };
}
type SubtaskView = ReturnType<typeof subtaskView>;

/** TODO ごとのサブタスク（並び順） */
async function subtasksByTodo(c: Ctx, todoIds: string[]): Promise<Map<string, SubtaskView[]>> {
  const map = new Map<string, SubtaskView[]>();
  if (todoIds.length === 0) return map;
  const rows = await c
    .get("db")
    .select({ subtask: todoSubtasks, doneByName: subtaskDoneUser.displayName })
    .from(todoSubtasks)
    .leftJoin(subtaskDoneUser, eq(todoSubtasks.doneBy, subtaskDoneUser.id))
    .where(inArray(todoSubtasks.todoId, todoIds))
    .orderBy(asc(todoSubtasks.sortOrder), asc(todoSubtasks.createdAt), asc(todoSubtasks.id))
    .all();
  for (const r of rows) map.set(r.subtask.todoId, [...(map.get(r.subtask.todoId) ?? []), subtaskView(r.subtask, r.doneByName)]);
  return map;
}

/** 期限から見た状態。済み・期限なしは null（今日の画面は overdue と today を出す） */
function dueState(todo: TodoRow, today: DateStr) {
  if (todo.doneAt || !todo.dueOn) return { dueStatus: null, daysLate: 0 };
  const late = diffDays(todo.dueOn, today);
  return { dueStatus: late > 0 ? ("overdue" as const) : late === 0 ? ("today" as const) : ("upcoming" as const), daysLate: Math.max(late, 0) };
}

function view({ todo, assigneeName, groupName, createdByName, doneByName }: Named, subtasks: SubtaskView[], today: DateStr) {
  return {
    id: todo.id,
    familyId: todo.familyId,
    title: todo.title,
    memo: todo.memo,
    hasMemo: !!todo.memo,
    dueOn: todo.dueOn,
    ...dueState(todo, today),
    assigneeUserId: todo.assigneeUserId,
    assigneeName,
    groupId: todo.groupId,
    groupName,
    notifyTime: todo.notifyTime,
    createdByName,
    done: !!todo.doneAt,
    doneAt: todo.doneAt,
    doneByName,
    sortOrder: todo.sortOrder,
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
    subtasks,
    progress: { done: subtasks.filter((s) => s.done).length, total: subtasks.length },
  };
}

async function loadView(c: Ctx, id: string) {
  const r = (await selectNamed(c).where(eq(todos.id, id)).get())!;
  const subs = (await subtasksByTodo(c, [id])).get(id) ?? [];
  return view(r, subs, todayInTokyo());
}

/** その TODO のサブタスクの次の並び順 */
async function nextSubtaskOrder(c: Ctx, todoId: string) {
  const r = await c.get("db").select({ m: max(todoSubtasks.sortOrder), n: sql<number>`count(*)` }).from(todoSubtasks).where(eq(todoSubtasks.todoId, todoId)).get();
  return { next: (r?.m ?? -1) + 1, count: r?.n ?? 0 };
}

type TodoInput = { title: unknown; memo: unknown; dueOn: unknown; assigneeUserId: unknown; groupId: unknown; notifyTime: unknown; subtasks: unknown };
type TodoPatch = Omit<TodoInput, "subtasks"> & { done: unknown; sortOrder: unknown };

export const todoRoutes = new Hono<AppEnv>()
  /**
   * 一覧。status=open（既定）は期限の近い順・期限なしは後ろ、done は済ませた新しい順（limit 件）。
   * due=today-or-overdue なら、未完了で期限が今日か過ぎているものだけ（今日の画面用）
   */
  .get("/families/:fid/todos", async (c) => {
    const fid = c.req.param("fid");
    await requireMember(c, fid);
    const status = c.req.query("status") ?? "open";
    const due = c.req.query("due");
    if (status !== "open" && status !== "done") fail(400, "status は open か done です");
    if (due !== undefined && due !== "today-or-overdue") fail(400, "due は today-or-overdue だけです");
    if (due && status !== "open") fail(400, "due は status=open のときだけ使えます");
    const today = todayInTokyo();
    let rows: Named[];
    if (status === "open") {
      rows = await selectNamed(c)
        .where(and(eq(todos.familyId, fid), isNull(todos.doneAt), due ? lte(todos.dueOn, today) : undefined))
        .orderBy(sql`${todos.dueOn} IS NULL`, asc(todos.dueOn), asc(todos.sortOrder), asc(todos.createdAt), asc(todos.id))
        .all();
    } else {
      const raw = Number(c.req.query("limit") ?? DONE_LIMIT_DEFAULT);
      const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, DONE_LIMIT_MAX) : DONE_LIMIT_DEFAULT;
      rows = await selectNamed(c)
        .where(and(eq(todos.familyId, fid), isNotNull(todos.doneAt)))
        .orderBy(desc(todos.doneAt), desc(todos.id))
        .limit(limit)
        .all();
    }
    const subs = await subtasksByTodo(
      c,
      rows.map((r) => r.todo.id),
    );
    return c.json({ today, todos: rows.map((r) => view(r, subs.get(r.todo.id) ?? [], today)) });
  })
  /** 登録。subtasks（題名の配列）で、サブタスクも一緒に作れる */
  .post("/families/:fid/todos", async (c) => {
    const fid = c.req.param("fid");
    const { userId } = await requireMember(c, fid);
    const b = await body<TodoInput>(c);
    const subtaskTitles = b.subtasks === undefined || b.subtasks === null ? [] : b.subtasks;
    if (!Array.isArray(subtaskTitles)) fail(400, "サブタスクが正しくありません");
    if (subtaskTitles.length > SUBTASKS_MAX) fail(400, `サブタスクは ${SUBTASKS_MAX} 個までです`);
    const db = c.get("db");
    const last = await db.select({ m: max(todos.sortOrder) }).from(todos).where(eq(todos.familyId, fid)).get();
    const row = {
      id: newId(),
      familyId: fid,
      title: validTodoTitle(b.title),
      memo: validMemo(b.memo),
      dueOn: validDueOn(b.dueOn),
      assigneeUserId: await validAssignee(c, fid, b.assigneeUserId),
      groupId: await validGroup(c, fid, b.groupId),
      notifyTime: validChoreNotify(b.notifyTime),
      createdBy: userId,
      sortOrder: (last?.m ?? -1) + 1,
    };
    const subRows = subtaskTitles.map((t, i) => ({ id: newId(), todoId: row.id, title: validSubtaskTitle(t), sortOrder: i }));
    await db.batch([db.insert(todos).values(row), ...subRows.map((s) => db.insert(todoSubtasks).values(s))]);
    return c.json(await loadView(c, row.id), 201);
  })
  .get("/todos/:id", async (c) => {
    const { todo } = await loadTodo(c, c.req.param("id"));
    return c.json({ ...(await loadView(c, todo.id)), today: todayInTokyo() });
  })
  /** 直す。来なかった項目は変えない。done: true で済み（済ませた人と時刻を記録）、false で取り消し */
  .patch("/todos/:id", async (c) => {
    const { todo, userId } = await loadTodo(c, c.req.param("id"));
    const b = await body<TodoPatch>(c);
    const set: Partial<typeof todos.$inferInsert> = { updatedAt: nowIso() };
    if (b.title !== undefined) set.title = validTodoTitle(b.title);
    if (b.memo !== undefined) set.memo = validMemo(b.memo);
    if (b.dueOn !== undefined) set.dueOn = validDueOn(b.dueOn);
    if (b.assigneeUserId !== undefined) set.assigneeUserId = await validAssignee(c, todo.familyId, b.assigneeUserId);
    if (b.groupId !== undefined) set.groupId = await validGroup(c, todo.familyId, b.groupId);
    if (b.notifyTime !== undefined) set.notifyTime = validChoreNotify(b.notifyTime);
    if (b.sortOrder !== undefined) set.sortOrder = validSortOrder(b.sortOrder);
    if (b.done !== undefined) {
      // もう済んでいれば、済ませた人と時刻はそのまま（2回押しても最初の人のまま）
      if (validDone(b.done)) Object.assign(set, todo.doneAt ? {} : { doneAt: nowIso(), doneBy: userId });
      else Object.assign(set, { doneAt: null, doneBy: null });
    }
    await c.get("db").update(todos).set(set).where(eq(todos.id, todo.id));
    return c.json(await loadView(c, todo.id));
  })
  .delete("/todos/:id", async (c) => {
    const { todo } = await loadTodo(c, c.req.param("id"));
    await c.get("db").delete(todos).where(eq(todos.id, todo.id)); // サブタスクも cascade で消える
    return c.json({ ok: true });
  })

  // ---- サブタスク（1段だけ。サブタスクの下には足せない） ----
  .post("/todos/:id/subtasks", async (c) => {
    const { todo } = await loadTodo(c, c.req.param("id"));
    const { title } = await body<{ title: string }>(c);
    const t = validSubtaskTitle(title);
    const { next, count } = await nextSubtaskOrder(c, todo.id);
    if (count >= SUBTASKS_MAX) fail(400, `サブタスクは ${SUBTASKS_MAX} 個までです`);
    const id = newId();
    await c.get("db").insert(todoSubtasks).values({ id, todoId: todo.id, title: t, sortOrder: next });
    const s = (await c.get("db").select().from(todoSubtasks).where(eq(todoSubtasks.id, id)).get())!;
    return c.json(subtaskView(s, null), 201);
  })
  /** 題名・済み・並び順。サブタスクを全部済ませても、親の TODO は済みにしない */
  .patch("/subtasks/:id", async (c) => {
    const { subtask, userId } = await loadSubtask(c, c.req.param("id"));
    const b = await body<{ title: unknown; done: unknown; sortOrder: unknown }>(c);
    const set: Partial<typeof todoSubtasks.$inferInsert> = {};
    if (b.title !== undefined) set.title = validSubtaskTitle(b.title);
    if (b.sortOrder !== undefined) set.sortOrder = validSortOrder(b.sortOrder);
    if (b.done !== undefined) {
      if (validDone(b.done)) Object.assign(set, subtask.doneAt ? {} : { doneAt: nowIso(), doneBy: userId });
      else Object.assign(set, { doneAt: null, doneBy: null });
    }
    const db = c.get("db");
    if (Object.keys(set).length) await db.update(todoSubtasks).set(set).where(eq(todoSubtasks.id, subtask.id));
    await db.update(todos).set({ updatedAt: nowIso() }).where(eq(todos.id, subtask.todoId));
    const r = (await db
      .select({ subtask: todoSubtasks, doneByName: subtaskDoneUser.displayName })
      .from(todoSubtasks)
      .leftJoin(subtaskDoneUser, eq(todoSubtasks.doneBy, subtaskDoneUser.id))
      .where(eq(todoSubtasks.id, subtask.id))
      .get())!;
    return c.json(subtaskView(r.subtask, r.doneByName));
  })
  .delete("/subtasks/:id", async (c) => {
    const { subtask } = await loadSubtask(c, c.req.param("id"));
    await c.get("db").delete(todoSubtasks).where(eq(todoSubtasks.id, subtask.id));
    return c.json({ ok: true });
  });
