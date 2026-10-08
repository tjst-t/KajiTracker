// 家事と記録。仕様は docs/spec.md「家事」「記録」、期限の計算は src/shared/schedule.ts。
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { body } from "../auth/routes";
import { validNotifyTime } from "../auth/routes";
import type { AppEnv, Ctx } from "../context";
import { fail, nowIso, requireAuth } from "../context";
import { choreGroups, chores, familyMembers, logs, users } from "../db/schema";
import { validGroup } from "./groups";
import { requireMember } from "../families/routes";
import { newId } from "../lib/crypto";
import { type DateStr, diffDays, isDateStr, todayInTokyo, toDayNum } from "../../shared/date";
import { type Cycle, type Evaluation, type Schedule, evaluate, isOccurrence, parseCalendarRule } from "../../shared/schedule";

type ChoreRow = typeof chores.$inferSelect;

export function scheduleOf(c: ChoreRow): Schedule {
  return c.scheduleType === "interval"
    ? { type: "interval", intervalDays: c.intervalDays!, firstDueOn: c.firstDueOn! }
    : { type: "calendar", rule: parseCalendarRule(JSON.parse(c.calendarRule!)) };
}

/** 画面から来た周期を確かめ、chores の列にする */
function scheduleColumns(input: unknown, today: DateStr, previous?: ChoreRow) {
  const s = input as { type?: string; intervalDays?: unknown; firstDueOn?: unknown; rule?: Record<string, unknown> } | undefined;
  if (s?.type === "interval") {
    const n = s.intervalDays;
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 3660) fail(400, "何日ごとかを 1〜3660 の数で入れてください");
    if (!isDateStr(s.firstDueOn)) fail(400, "最初の期限を日付で入れてください");
    return { scheduleType: "interval" as const, intervalDays: n as number, firstDueOn: s.firstDueOn, calendarRule: null };
  }
  if (s?.type === "calendar") {
    const raw = { ...(s.rule ?? {}) };
    const every = (raw.every as number | undefined) ?? 1;
    if (raw.anchor === undefined || raw.anchor === null || raw.anchor === "") {
      if (every >= 2) fail(400, "隔週・数か月ごとのときは、最初の予定日を選んでください", "anchor_required");
      // 毎週・毎月は登録した日から数える。編集では前の基準日を引き継ぐ
      const prevRule = previous?.calendarRule ? (JSON.parse(previous.calendarRule) as { anchor?: string }) : null;
      raw.anchor = prevRule?.anchor ?? today;
    }
    let rule;
    try {
      rule = parseCalendarRule(raw);
    } catch (e) {
      fail(400, (e as Error).message);
    }
    if (rule.every >= 2 && !isOccurrence(rule, toDayNum(rule.anchor))) {
      fail(400, "最初の予定日は、選んだ曜日・日に当たる日にしてください", "anchor_not_occurrence");
    }
    return { scheduleType: "calendar" as const, intervalDays: null, firstDueOn: null, calendarRule: JSON.stringify(rule) };
  }
  return fail(400, "周期の種類を選んでください");
}

/** 担当者を確かめる。known（先に引いたその Family の人の id）があれば DB を引かない */
async function validAssignee(c: Ctx, familyId: string, assignee: unknown, known?: Set<string>): Promise<string | null> {
  if (assignee === null || assignee === undefined || assignee === "") return null;
  if (typeof assignee !== "string") fail(400, "担当者が正しくありません");
  if (known) return known.has(assignee) ? assignee : fail(400, "担当者はこの Family の人から選んでください");
  const m = await c
    .get("db")
    .select()
    .from(familyMembers)
    .where(and(eq(familyMembers.familyId, familyId), eq(familyMembers.userId, assignee)))
    .get();
  if (!m) fail(400, "担当者はこの Family の人から選んでください");
  return assignee;
}

function validName(name: unknown): string {
  const n = typeof name === "string" ? name.trim() : "";
  if ([...n].length < 1 || [...n].length > 40) fail(400, "家事の名前を1〜40文字で入れてください");
  return n;
}

function validChoreNotify(t: unknown): string | null {
  if (t === null || t === undefined || t === "") return null;
  if (typeof t !== "string" || !validNotifyTime(t)) fail(400, "通知の時刻は 15 分きざみ（例 07:00）で選んでください");
  return t;
}

/** 家事を引き、その Family のメンバーか確かめる */
async function loadChore(c: Ctx, id: string) {
  requireAuth(c);
  const chore = await c.get("db").select().from(chores).where(eq(chores.id, id)).get();
  if (!chore) fail(404, "その家事はありません", "chore_not_found");
  await requireMember(c, chore.familyId).catch(() => fail(404, "その家事はありません", "chore_not_found"));
  return chore;
}

type LogView = { id: string; doneOn: string; userId: string; userName: string; createdAt: string };

/** 家事ごとの、取り消していない記録（新しい順） */
async function logsByChore(c: Ctx, choreIds: string[]): Promise<Map<string, LogView[]>> {
  const map = new Map<string, LogView[]>();
  if (choreIds.length === 0) return map;
  const rows = await c
    .get("db")
    .select({ id: logs.id, choreId: logs.choreId, doneOn: logs.doneOn, userId: logs.userId, userName: users.displayName, createdAt: logs.createdAt })
    .from(logs)
    .innerJoin(users, eq(logs.userId, users.id))
    .where(and(inArray(logs.choreId, choreIds), isNull(logs.deletedAt)))
    .orderBy(desc(logs.doneOn), desc(logs.createdAt))
    .all();
  for (const r of rows) {
    const list = map.get(r.choreId) ?? [];
    list.push({ id: r.id, doneOn: r.doneOn, userId: r.userId, userName: r.userName, createdAt: r.createdAt });
    map.set(r.choreId, list);
  }
  return map;
}

function view(chore: ChoreRow, assigneeName: string | null, groupName: string | null, choreLogs: LogView[], today: DateStr) {
  const schedule = scheduleOf(chore);
  const ev = evaluate(schedule, choreLogs.map((l) => l.doneOn), today);
  return {
    id: chore.id,
    familyId: chore.familyId,
    name: chore.name,
    schedule,
    assigneeUserId: chore.assigneeUserId,
    assigneeName,
    groupId: chore.groupId,
    groupName,
    notifyTime: chore.notifyTime,
    archived: !!chore.archivedAt,
    dueOn: ev.dueOn,
    status: ev.status,
    daysLate: ev.daysLate,
    lastLog: choreLogs[0] ?? null,
    _ev: ev,
  };
}

/** 家事ごとの統計（家事の詳細で出す） */
export function choreStats(schedule: Schedule, ev: Evaluation, doneOns: DateStr[]) {
  const done = ev.cycles.filter((c): c is Cycle & { doneOn: string; daysLate: number } => c.doneOn !== null);
  const missed = ev.cycles.filter((c) => c.missed).length;
  const judged = done.length + missed;
  const onTime = done.filter((c) => c.daysLate === 0).length;
  const sorted = [...new Set(doneOns)].sort();
  const gaps = sorted.slice(1).map((d, i) => diffDays(sorted[i]!, d));
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  return {
    doneCount: doneOns.length,
    onTimeRate: judged ? Math.round((onTime / judged) * 100) : null,
    averageDaysLate: avg(done.map((c) => c.daysLate)),
    missedCount: missed,
    averageInterval: avg(gaps),
    plannedInterval: schedule.type === "interval" ? schedule.intervalDays : null,
  };
}

/** 家事1つを、担当とグループの名前つきで引く */
async function loadNamed(c: Ctx, id: string) {
  const r = await c
    .get("db")
    .select({ chore: chores, assigneeName: users.displayName, groupName: choreGroups.name })
    .from(chores)
    .leftJoin(users, eq(chores.assigneeUserId, users.id))
    .leftJoin(choreGroups, eq(chores.groupId, choreGroups.id))
    .where(eq(chores.id, id))
    .get();
  return r!;
}

type ChoreInput = { name: unknown; schedule: unknown; assigneeUserId: unknown; groupId: unknown; notifyTime: unknown };

/** 画面から来た1つの家事を確かめ、chores に入れる行にする（まだ入れない） */
async function buildChoreRow(c: Ctx, fid: string, userId: string, b: Partial<ChoreInput>, today: DateStr) {
  return {
    id: newId(),
    familyId: fid,
    name: validName(b.name),
    ...scheduleColumns(b.schedule, today),
    assigneeUserId: await validAssignee(c, fid, b.assigneeUserId),
    groupId: await validGroup(c, fid, b.groupId),
    notifyTime: validChoreNotify(b.notifyTime),
    createdBy: userId,
  };
}

type ChorePatch = Partial<ChoreInput> & { archived?: unknown };
type FamilyRefs = { members: Set<string>; groups: Set<string> };

/** その Family の人とグループの id（まとめて直すとき、行ごとに DB を引かないように） */
async function familyRefs(c: Ctx, fid: string): Promise<FamilyRefs> {
  const db = c.get("db");
  const [m, g] = await Promise.all([
    db.select({ id: familyMembers.userId }).from(familyMembers).where(eq(familyMembers.familyId, fid)).all(),
    db.select({ id: choreGroups.id }).from(choreGroups).where(eq(choreGroups.familyId, fid)).all(),
  ]);
  return { members: new Set(m.map((r) => r.id)), groups: new Set(g.map((r) => r.id)) };
}

/** 家事1つへの変更を確かめ、chores の update に渡す値にする（まだ入れない）。来なかった項目は変えない */
async function buildChorePatch(c: Ctx, chore: ChoreRow, b: ChorePatch, today: DateStr, refs?: FamilyRefs) {
  const set: Partial<typeof chores.$inferInsert> = { updatedAt: nowIso() };
  if (b.name !== undefined) set.name = validName(b.name);
  // 毎週・毎月で基準日が来なければ、前の基準日を引き継ぐ
  if (b.schedule !== undefined) Object.assign(set, scheduleColumns(b.schedule, today, chore));
  if (b.assigneeUserId !== undefined) set.assigneeUserId = await validAssignee(c, chore.familyId, b.assigneeUserId, refs?.members);
  if (b.groupId !== undefined) set.groupId = await validGroup(c, chore.familyId, b.groupId, refs?.groups);
  if (b.notifyTime !== undefined) set.notifyTime = validChoreNotify(b.notifyTime);
  if (b.archived !== undefined) set.archivedAt = b.archived ? (chore.archivedAt ?? nowIso()) : null;
  return set;
}

const BULK_MAX = 100;
const BULK_EDIT_MAX = 200;

const strip = <T extends { _ev: unknown }>(v: T) => {
  const { _ev, ...rest } = v;
  return rest;
};

export const choreRoutes = new Hono<AppEnv>()
  .get("/families/:fid/chores", async (c) => {
    const fid = c.req.param("fid");
    await requireMember(c, fid);
    const includeArchived = c.req.query("archived") === "1";
    const db = c.get("db");
    const rows = await db
      .select({ chore: chores, assigneeName: users.displayName, groupName: choreGroups.name })
      .from(chores)
      .leftJoin(users, eq(chores.assigneeUserId, users.id))
      .leftJoin(choreGroups, eq(chores.groupId, choreGroups.id))
      .where(includeArchived ? eq(chores.familyId, fid) : and(eq(chores.familyId, fid), isNull(chores.archivedAt)))
      .all();
    const byChore = await logsByChore(
      c,
      rows.map((r) => r.chore.id),
    );
    const today = todayInTokyo();
    return c.json({ today, chores: rows.map((r) => strip(view(r.chore, r.assigneeName, r.groupName, byChore.get(r.chore.id) ?? [], today))) });
  })
  .post("/families/:fid/chores", async (c) => {
    const fid = c.req.param("fid");
    const { userId } = await requireMember(c, fid);
    const b = await body<ChoreInput>(c);
    const today = todayInTokyo();
    const row = await buildChoreRow(c, fid, userId, b, today);
    await c.get("db").insert(chores).values(row);
    const r = await loadNamed(c, row.id);
    return c.json(strip(view(r.chore, r.assigneeName, r.groupName, [], today)), 201);
  })
  /** まとめて登録。1行でも不備があれば1つも入れず、不備のある行を返す */
  .post("/families/:fid/chores/bulk", async (c) => {
    const fid = c.req.param("fid");
    const { userId } = await requireMember(c, fid);
    const { chores: input } = await body<{ chores: Partial<ChoreInput>[] }>(c);
    if (!Array.isArray(input) || input.length === 0) fail(400, "登録する家事がありません");
    if (input.length > BULK_MAX) fail(400, `一度に登録できるのは ${BULK_MAX} 件までです`);
    const today = todayInTokyo();
    const rows: Awaited<ReturnType<typeof buildChoreRow>>[] = [];
    const errors: { index: number; message: string }[] = [];
    for (const [index, b] of input.entries()) {
      try {
        rows.push(await buildChoreRow(c, fid, userId, b ?? {}, today));
      } catch (e) {
        if (!(e instanceof HTTPException)) throw e;
        errors.push({ index, message: e.message });
      }
    }
    if (errors.length) return c.json({ error: `${errors.length}件の行に不備があります`, code: "bulk_invalid", rows: errors }, 400);
    const db = c.get("db");
    const [first, ...more] = rows.map((r) => db.insert(chores).values(r));
    await db.batch([first!, ...more]);
    return c.json({ created: rows.length, ids: rows.map((r) => r.id) }, 201);
  })
  /** まとめて直す。1行でも不備があれば1つも変えず、不備のある行を返す（POST の bulk と同じ形） */
  .patch("/families/:fid/chores/bulk", async (c) => {
    const fid = c.req.param("fid");
    await requireMember(c, fid);
    const { chores: input } = await body<{ chores: (ChorePatch & { id?: unknown })[] }>(c);
    if (!Array.isArray(input) || input.length === 0) fail(400, "直す家事がありません");
    if (input.length > BULK_EDIT_MAX) fail(400, `一度に直せるのは ${BULK_EDIT_MAX} 件までです`);
    const db = c.get("db");
    const ids = [...new Set(input.map((b) => b?.id).filter((id): id is string => typeof id === "string"))];
    const found = ids.length ? await db.select().from(chores).where(and(eq(chores.familyId, fid), inArray(chores.id, ids))).all() : [];
    const byId = new Map(found.map((r) => [r.id, r]));
    const refs = await familyRefs(c, fid);
    const today = todayInTokyo();
    const updates: { id: string; set: Awaited<ReturnType<typeof buildChorePatch>> }[] = [];
    const errors: { index: number; message: string }[] = [];
    const seen = new Set<string>();
    for (const [index, b] of input.entries()) {
      try {
        // よその Family の家事も「ありません」にする（あるかどうかを漏らさない）
        const chore = typeof b?.id === "string" ? byId.get(b.id) : undefined;
        if (!chore) fail(400, "その家事はありません");
        if (seen.has(chore.id)) fail(400, "同じ家事が2回あります");
        seen.add(chore.id);
        updates.push({ id: chore.id, set: await buildChorePatch(c, chore, b, today, refs) });
      } catch (e) {
        if (!(e instanceof HTTPException)) throw e;
        errors.push({ index, message: e.message });
      }
    }
    if (errors.length) return c.json({ error: `${errors.length}件の行に不備があります`, code: "bulk_invalid", rows: errors }, 400);
    const [first, ...more] = updates.map((u) => db.update(chores).set(u.set).where(eq(chores.id, u.id)));
    await db.batch([first!, ...more]);
    return c.json({ updated: updates.length });
  })
  .get("/chores/:id", async (c) => {
    const chore = await loadChore(c, c.req.param("id"));
    const { assigneeName, groupName } = await loadNamed(c, chore.id);
    const choreLogs = (await logsByChore(c, [chore.id])).get(chore.id) ?? [];
    const today = todayInTokyo();
    const v = view(chore, assigneeName, groupName, choreLogs, today);
    return c.json({
      ...strip(v),
      logs: choreLogs,
      cycles: v._ev.cycles,
      stats: choreStats(v.schedule, v._ev, choreLogs.map((l) => l.doneOn)),
      today,
    });
  })
  .patch("/chores/:id", async (c) => {
    const chore = await loadChore(c, c.req.param("id"));
    const b = await body<ChorePatch>(c);
    const set = await buildChorePatch(c, chore, b, todayInTokyo());
    await c.get("db").update(chores).set(set).where(eq(chores.id, chore.id));
    return c.json({ ok: true });
  })
  .delete("/chores/:id", async (c) => {
    const chore = await loadChore(c, c.req.param("id"));
    await c.get("db").delete(chores).where(eq(chores.id, chore.id)); // 記録も cascade で消える
    return c.json({ ok: true });
  })

  // ---- 記録 ----
  .post("/chores/:id/logs", async (c) => {
    const { user } = requireAuth(c);
    const chore = await loadChore(c, c.req.param("id"));
    const { doneOn } = await body<{ doneOn: string }>(c);
    const today = todayInTokyo();
    const d = doneOn ?? today;
    if (!isDateStr(d)) fail(400, "やった日を日付で入れてください");
    if (d > today) fail(400, "先の日付では記録できません");
    if (d < "2000-01-01") fail(400, "日付が古すぎます");
    const id = newId();
    await c.get("db").insert(logs).values({ id, choreId: chore.id, familyId: chore.familyId, userId: user.id, doneOn: d });
    const choreLogs = (await logsByChore(c, [chore.id])).get(chore.id) ?? [];
    const ev = evaluate(
      scheduleOf(chore),
      choreLogs.map((l) => l.doneOn),
      today,
    );
    return c.json({ log: { id, doneOn: d, userId: user.id, userName: user.displayName }, dueOn: ev.dueOn, status: ev.status, daysLate: ev.daysLate }, 201);
  })
  /** 取り消し。記録は消さずに deleted_at を付ける（統計と期限の計算から外れる） */
  .delete("/logs/:id", async (c) => {
    requireAuth(c);
    const log = await c.get("db").select().from(logs).where(eq(logs.id, c.req.param("id"))).get();
    if (!log || log.deletedAt) fail(404, "その記録はありません");
    await requireMember(c, log.familyId).catch(() => fail(404, "その記録はありません"));
    await c.get("db").update(logs).set({ deletedAt: nowIso() }).where(eq(logs.id, log.id));
    return c.json({ ok: true });
  });
