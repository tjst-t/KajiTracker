// 家事のグループ（キッチン・風呂など）。Family ごとに自由に作れる
import { and, asc, eq, max } from "drizzle-orm";
import { Hono } from "hono";
import { body } from "../auth/routes";
import type { AppEnv, Ctx } from "../context";
import { fail, requireAuth } from "../context";
import { choreGroups, chores } from "../db/schema";
import { requireMember } from "../families/routes";
import { newId } from "../lib/crypto";

function validGroupName(name: unknown): string {
  const n = typeof name === "string" ? name.trim() : "";
  if ([...n].length < 1 || [...n].length > 20) fail(400, "グループの名前を1〜20文字で入れてください");
  return n;
}

async function loadGroup(c: Ctx, id: string) {
  requireAuth(c);
  const g = await c.get("db").select().from(choreGroups).where(eq(choreGroups.id, id)).get();
  if (!g) fail(404, "そのグループはありません");
  await requireMember(c, g.familyId).catch(() => fail(404, "そのグループはありません"));
  return g;
}

/** 家事に付けるグループを確かめる。null・空ならグループ無し。known（先に引いたその Family のグループの id）があれば DB を引かない */
export async function validGroup(c: Ctx, familyId: string, groupId: unknown, known?: Set<string>): Promise<string | null> {
  if (groupId === null || groupId === undefined || groupId === "") return null;
  if (typeof groupId !== "string") fail(400, "グループが正しくありません");
  if (known) return known.has(groupId) ? groupId : fail(400, "グループはこの Family のものから選んでください");
  const g = await c
    .get("db")
    .select()
    .from(choreGroups)
    .where(and(eq(choreGroups.id, groupId), eq(choreGroups.familyId, familyId)))
    .get();
  if (!g) fail(400, "グループはこの Family のものから選んでください");
  return groupId;
}

export const groupRoutes = new Hono<AppEnv>()
  .get("/families/:fid/groups", async (c) => {
    const fid = c.req.param("fid");
    await requireMember(c, fid);
    const rows = await c
      .get("db")
      .select({ id: choreGroups.id, name: choreGroups.name, sortOrder: choreGroups.sortOrder })
      .from(choreGroups)
      .where(eq(choreGroups.familyId, fid))
      .orderBy(asc(choreGroups.sortOrder), asc(choreGroups.createdAt))
      .all();
    return c.json(rows);
  })
  .post("/families/:fid/groups", async (c) => {
    const fid = c.req.param("fid");
    await requireMember(c, fid);
    const { name } = await body<{ name: string }>(c);
    const db = c.get("db");
    const last = await db.select({ m: max(choreGroups.sortOrder) }).from(choreGroups).where(eq(choreGroups.familyId, fid)).get();
    const row = { id: newId(), familyId: fid, name: validGroupName(name), sortOrder: (last?.m ?? -1) + 1 };
    await db.insert(choreGroups).values(row);
    return c.json({ id: row.id, name: row.name, sortOrder: row.sortOrder }, 201);
  })
  .patch("/groups/:id", async (c) => {
    const g = await loadGroup(c, c.req.param("id"));
    const { name, sortOrder } = await body<{ name: string; sortOrder: number }>(c);
    const set: Partial<typeof choreGroups.$inferInsert> = {};
    if (name !== undefined) set.name = validGroupName(name);
    if (sortOrder !== undefined) {
      if (!Number.isInteger(sortOrder)) fail(400, "並び順は整数です");
      set.sortOrder = sortOrder;
    }
    if (Object.keys(set).length) await c.get("db").update(choreGroups).set(set).where(eq(choreGroups.id, g.id));
    return c.json({ ok: true });
  })
  /** グループを消す。入っていた家事はグループ無しになる（家事は消えない） */
  .delete("/groups/:id", async (c) => {
    const g = await loadGroup(c, c.req.param("id"));
    const db = c.get("db");
    await db.batch([db.update(chores).set({ groupId: null }).where(eq(chores.groupId, g.id)), db.delete(choreGroups).where(eq(choreGroups.id, g.id))]);
    return c.json({ ok: true });
  });
