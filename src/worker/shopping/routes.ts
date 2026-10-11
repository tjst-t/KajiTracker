// 買い物のリスト（お店ごと）・売り場・品物・買った記録。仕様は docs/spec.md「買い物」。
// 品物の追加・状態・削除は、同じ要求を2回送っても結果が同じ（電波の弱い店で送り直せるように）
import { and, asc, count, desc, eq, inArray, max } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Hono } from "hono";
import { body } from "../auth/routes";
import type { AppEnv, Ctx } from "../context";
import { fail, nowIso, requireAuth } from "../context";
import { shoppingItems, shoppingLists, shoppingPurchases, shoppingSections, users } from "../db/schema";
import { requireMember } from "../families/routes";
import { newId } from "../lib/crypto";
import { insertDefaultSections } from "./defaults";

const LISTS_MAX = 20;
const SECTIONS_MAX = 30;
const ITEMS_MAX = 300;
/** よく買うものの候補の数 */
const FREQUENT_MAX = 50;
/** D1 は1つの文の値を 100 個までしか受け付けない */
const PARAMS_MAX = 100;

type ItemRow = typeof shoppingItems.$inferSelect;
type Status = ItemRow["status"];

function validText(v: unknown, maxLen: number, message: string): string {
  const n = typeof v === "string" ? v.trim() : "";
  if ([...n].length < 1 || [...n].length > maxLen) fail(400, message);
  return n;
}
const validListName = (v: unknown) => validText(v, 20, "リストの名前を1〜20文字で入れてください");
const validSectionName = (v: unknown) => validText(v, 20, "売り場の名前を1〜20文字で入れてください");
const validItemName = (v: unknown) => validText(v, 40, "品物の名前を1〜40文字で入れてください");

function validNote(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") fail(400, "数量・メモが正しくありません");
  const n = v.trim();
  if ([...n].length > 40) fail(400, "数量・メモは40文字までです");
  return n || null;
}

function validStatus(v: unknown): Status {
  if (v !== "open" && v !== "in_cart") fail(400, "状態は open か in_cart です");
  return v;
}

function validSortOrder(v: unknown): number {
  if (!Number.isInteger(v)) fail(400, "並び順は整数です");
  return v as number;
}

/** 画面で作った品物の id（ランダムな文字列）。無ければサーバで作る */
function validItemId(v: unknown): string {
  if (v === undefined || v === null) return newId();
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(v)) fail(400, "品物の id は 8〜64 文字の英数字・-・_ です");
  return v;
}

const chunk = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

async function loadList(c: Ctx, id: string) {
  requireAuth(c);
  const l = await c.get("db").select().from(shoppingLists).where(eq(shoppingLists.id, id)).get();
  if (!l) fail(404, "そのリストはありません", "list_not_found");
  const m = await requireMember(c, l.familyId).catch(() => fail(404, "そのリストはありません", "list_not_found"));
  return { list: l, userId: m.userId };
}

async function loadSection(c: Ctx, id: string) {
  requireAuth(c);
  const row = await c
    .get("db")
    .select({ section: shoppingSections, familyId: shoppingLists.familyId })
    .from(shoppingSections)
    .innerJoin(shoppingLists, eq(shoppingSections.listId, shoppingLists.id))
    .where(eq(shoppingSections.id, id))
    .get();
  if (!row) fail(404, "その売り場はありません");
  await requireMember(c, row.familyId).catch(() => fail(404, "その売り場はありません"));
  return row.section;
}

/** 品物を引き、その Family のメンバーか確かめる。無ければ null */
async function findItem(c: Ctx, id: string) {
  requireAuth(c);
  const item = await c.get("db").select().from(shoppingItems).where(eq(shoppingItems.id, id)).get();
  if (!item) return null;
  const m = await requireMember(c, item.familyId).catch(() => fail(404, "その品物はありません", "item_not_found"));
  return { item, userId: m.userId };
}

/** 品物に付ける売り場を確かめる。null・空なら売り場なし */
async function validSection(c: Ctx, listId: string, sectionId: unknown): Promise<string | null> {
  if (sectionId === null || sectionId === undefined || sectionId === "") return null;
  if (typeof sectionId !== "string") fail(400, "売り場が正しくありません");
  const s = await c
    .get("db")
    .select({ id: shoppingSections.id })
    .from(shoppingSections)
    .where(and(eq(shoppingSections.id, sectionId), eq(shoppingSections.listId, listId)))
    .get();
  if (!s) fail(400, "売り場はこのリストのものから選んでください");
  return sectionId;
}

const addedUser = alias(users, "added_user");
const cartUser = alias(users, "cart_user");

/** 品物を、入れた人・カゴに入れた人の名前つきで引く */
function selectItems(c: Ctx) {
  return c
    .get("db")
    .select({ item: shoppingItems, addedByName: addedUser.displayName, cartByName: cartUser.displayName })
    .from(shoppingItems)
    .leftJoin(addedUser, eq(shoppingItems.addedBy, addedUser.id))
    .leftJoin(cartUser, eq(shoppingItems.cartBy, cartUser.id));
}

function itemView({ item, addedByName, cartByName }: { item: ItemRow; addedByName: string | null; cartByName: string | null }) {
  return {
    id: item.id,
    listId: item.listId,
    name: item.name,
    note: item.note,
    sectionId: item.sectionId,
    status: item.status,
    addedByName,
    cartByName,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

async function loadItemView(c: Ctx, id: string) {
  return itemView((await selectItems(c).where(eq(shoppingItems.id, id)).get())!);
}

/** Family のリスト（並び順）と、それぞれの未購入・カゴの数 */
async function listSummaries(c: Ctx, familyId: string) {
  const db = c.get("db");
  const [lists, counts] = await Promise.all([
    db
      .select({ id: shoppingLists.id, name: shoppingLists.name, sortOrder: shoppingLists.sortOrder })
      .from(shoppingLists)
      .where(eq(shoppingLists.familyId, familyId))
      .orderBy(asc(shoppingLists.sortOrder), asc(shoppingLists.createdAt))
      .all(),
    db
      .select({ listId: shoppingItems.listId, status: shoppingItems.status, n: count() })
      .from(shoppingItems)
      .where(eq(shoppingItems.familyId, familyId))
      .groupBy(shoppingItems.listId, shoppingItems.status)
      .all(),
  ]);
  const n = (id: string, s: Status) => counts.find((r) => r.listId === id && r.status === s)?.n ?? 0;
  return lists.map((l) => ({ ...l, openCount: n(l.id, "open"), cartCount: n(l.id, "in_cart") }));
}

type Frequent = { name: string; count: number; lastBoughtAt: string; sectionId: string | null };

/** そのリストで前に買った名前。回数の多い順・新しい順。売り場は最後に買ったときのもの */
async function frequentNames(c: Ctx, listId: string): Promise<Frequent[]> {
  // SQLite では max() と並べた列は、その max の行の値になる（最後に買ったときの売り場）
  const r = await c.env.DB.prepare(
    `SELECT name, count(*) AS count, max(bought_at) AS lastBoughtAt, section_id AS sectionId
       FROM shopping_purchases WHERE list_id = ?
       GROUP BY name ORDER BY count DESC, lastBoughtAt DESC LIMIT ?`,
  )
    .bind(listId, FREQUENT_MAX + ITEMS_MAX)
    .all<Frequent>();
  return r.results;
}

/** 前に買ったときの売り場（名前が同じで、いちばん新しいもの）。無ければ null */
async function rememberedSection(c: Ctx, listId: string, name: string): Promise<string | null> {
  const r = await c
    .get("db")
    .select({ sectionId: shoppingPurchases.sectionId })
    .from(shoppingPurchases)
    .where(and(eq(shoppingPurchases.listId, listId), eq(shoppingPurchases.name, name)))
    .orderBy(desc(shoppingPurchases.boughtAt))
    .get();
  return r?.sectionId ?? null;
}

export const shoppingRoutes = new Hono<AppEnv>()
  // ---- リスト ----
  .get("/families/:fid/shopping-lists", async (c) => {
    const fid = c.req.param("fid");
    await requireMember(c, fid);
    return c.json(await listSummaries(c, fid));
  })
  .post("/families/:fid/shopping-lists", async (c) => {
    const fid = c.req.param("fid");
    await requireMember(c, fid);
    const { name } = await body<{ name: string }>(c);
    const n = validListName(name);
    const db = c.get("db");
    const last = await db
      .select({ m: max(shoppingLists.sortOrder), n: count() })
      .from(shoppingLists)
      .where(eq(shoppingLists.familyId, fid))
      .get();
    if ((last?.n ?? 0) >= LISTS_MAX) fail(400, `リストは ${LISTS_MAX} 個までです`);
    const row = { id: newId(), familyId: fid, name: n, sortOrder: (last?.m ?? -1) + 1 };
    await db.batch([db.insert(shoppingLists).values(row), insertDefaultSections(db, row.id)]);
    return c.json({ id: row.id, name: row.name, sortOrder: row.sortOrder }, 201);
  })
  /** リストの中身：売り場・品物・よく買うもの。ほかのリストの数も返す（画面はこれを5秒ごとに読み直す） */
  .get("/shopping-lists/:id", async (c) => {
    const { list } = await loadList(c, c.req.param("id"));
    const db = c.get("db");
    const [lists, sections, items, purchased] = await Promise.all([
      listSummaries(c, list.familyId),
      db
        .select({ id: shoppingSections.id, name: shoppingSections.name, sortOrder: shoppingSections.sortOrder })
        .from(shoppingSections)
        .where(eq(shoppingSections.listId, list.id))
        .orderBy(asc(shoppingSections.sortOrder), asc(shoppingSections.createdAt))
        .all(),
      selectItems(c).where(eq(shoppingItems.listId, list.id)).orderBy(asc(shoppingItems.createdAt)).all(),
      frequentNames(c, list.id),
    ]);
    // すでにリストにあるものは候補に出さない
    const inList = new Set(items.map((r) => r.item.name));
    const frequent = purchased.filter((f) => !inList.has(f.name)).slice(0, FREQUENT_MAX);
    return c.json({ list: { id: list.id, familyId: list.familyId, name: list.name }, lists, sections, items: items.map(itemView), frequent });
  })
  .patch("/shopping-lists/:id", async (c) => {
    const { list } = await loadList(c, c.req.param("id"));
    const { name, sortOrder } = await body<{ name: string; sortOrder: number }>(c);
    const set: Partial<typeof shoppingLists.$inferInsert> = {};
    if (name !== undefined) set.name = validListName(name);
    if (sortOrder !== undefined) set.sortOrder = validSortOrder(sortOrder);
    if (Object.keys(set).length) await c.get("db").update(shoppingLists).set(set).where(eq(shoppingLists.id, list.id));
    return c.json({ ok: true });
  })
  /** リストを消す。売り場・品物・買った記録も消える */
  .delete("/shopping-lists/:id", async (c) => {
    const { list } = await loadList(c, c.req.param("id"));
    await c.get("db").delete(shoppingLists).where(eq(shoppingLists.id, list.id));
    return c.json({ ok: true });
  })

  // ---- 売り場 ----
  .post("/shopping-lists/:id/sections", async (c) => {
    const { list } = await loadList(c, c.req.param("id"));
    const { name } = await body<{ name: string }>(c);
    const n = validSectionName(name);
    const db = c.get("db");
    const last = await db
      .select({ m: max(shoppingSections.sortOrder), n: count() })
      .from(shoppingSections)
      .where(eq(shoppingSections.listId, list.id))
      .get();
    if ((last?.n ?? 0) >= SECTIONS_MAX) fail(400, `売り場は1つのリストに ${SECTIONS_MAX} 個までです`);
    const row = { id: newId(), listId: list.id, name: n, sortOrder: (last?.m ?? -1) + 1 };
    await db.insert(shoppingSections).values(row);
    return c.json({ id: row.id, name: row.name, sortOrder: row.sortOrder }, 201);
  })
  .patch("/shopping-sections/:id", async (c) => {
    const s = await loadSection(c, c.req.param("id"));
    const { name, sortOrder } = await body<{ name: string; sortOrder: number }>(c);
    const set: Partial<typeof shoppingSections.$inferInsert> = {};
    if (name !== undefined) set.name = validSectionName(name);
    if (sortOrder !== undefined) set.sortOrder = validSortOrder(sortOrder);
    if (Object.keys(set).length) await c.get("db").update(shoppingSections).set(set).where(eq(shoppingSections.id, s.id));
    return c.json({ ok: true });
  })
  /** 売り場を消す。入っていた品物は「売り場なし」になる（品物は消えない） */
  .delete("/shopping-sections/:id", async (c) => {
    const s = await loadSection(c, c.req.param("id"));
    const db = c.get("db");
    await db.batch([
      db.update(shoppingItems).set({ sectionId: null }).where(eq(shoppingItems.sectionId, s.id)),
      db.update(shoppingPurchases).set({ sectionId: null }).where(eq(shoppingPurchases.sectionId, s.id)),
      db.delete(shoppingSections).where(eq(shoppingSections.id, s.id)),
    ]);
    return c.json({ ok: true });
  })

  // ---- 品物 ----
  /**
   * 品物を足す。id は画面で作ってよく、同じ id で2回来たら、2回目は何も変えずに 200 で今の品物を返す。
   * sectionId を送らなければ、前に買ったときの売り場に入れる（null を送れば売り場なし）
   */
  .post("/shopping-lists/:id/items", async (c) => {
    const { list, userId } = await loadList(c, c.req.param("id"));
    const b = await body<{ id: string; name: string; note: string; sectionId: string | null }>(c);
    const id = validItemId(b.id);
    const db = c.get("db");
    const existing = await db.select().from(shoppingItems).where(eq(shoppingItems.id, id)).get();
    if (existing) {
      if (existing.listId !== list.id) fail(409, "その id は使えません。新しい id で送ってください", "item_id_conflict");
      return c.json(await loadItemView(c, id), 200);
    }
    const name = validItemName(b.name);
    const note = validNote(b.note);
    const sectionId = b.sectionId === undefined ? await rememberedSection(c, list.id, name) : await validSection(c, list.id, b.sectionId);
    const n = await db.select({ n: count() }).from(shoppingItems).where(eq(shoppingItems.listId, list.id)).get();
    if ((n?.n ?? 0) >= ITEMS_MAX) fail(400, `1つのリストに入れられる品物は ${ITEMS_MAX} 個までです`);
    // 同時に同じ id が来ても1件だけ
    const inserted = await db
      .insert(shoppingItems)
      .values({ id, listId: list.id, familyId: list.familyId, name, note, sectionId, addedBy: userId })
      .onConflictDoNothing()
      .returning({ id: shoppingItems.id })
      .get();
    const item = await loadItemView(c, id);
    if (item.listId !== list.id) fail(409, "その id は使えません。新しい id で送ってください", "item_id_conflict");
    return c.json(item, inserted ? 201 : 200);
  })
  /** 品物を直す（状態・名前・数量メモ・売り場）。状態は切り替えではなく、なってほしい状態を送る（2回送っても同じ）。最後に書いた方が勝ち */
  .patch("/shopping-items/:id", async (c) => {
    const found = await findItem(c, c.req.param("id"));
    if (!found) fail(404, "その品物はありません。もう買い物を終えたか、消されています", "item_not_found");
    const { item, userId } = found;
    const b = await body<{ status: string; name: string; note: string | null; sectionId: string | null }>(c);
    const set: Partial<typeof shoppingItems.$inferInsert> = { updatedAt: nowIso() };
    if (b.status !== undefined) {
      const status = validStatus(b.status);
      set.status = status;
      // すでにカゴにあれば、入れた人は変えない
      set.cartBy = status === "in_cart" ? (item.status === "in_cart" ? item.cartBy : userId) : null;
    }
    if (b.name !== undefined) set.name = validItemName(b.name);
    if (b.note !== undefined) set.note = validNote(b.note);
    if (b.sectionId !== undefined) set.sectionId = await validSection(c, item.listId, b.sectionId);
    await c.get("db").update(shoppingItems).set(set).where(eq(shoppingItems.id, item.id));
    return c.json(await loadItemView(c, item.id));
  })
  /** 品物を消す（買わずに外す。履歴には残さない）。もう無ければ何もせず 200 */
  .delete("/shopping-items/:id", async (c) => {
    const found = await findItem(c, c.req.param("id"));
    if (found) await c.get("db").delete(shoppingItems).where(eq(shoppingItems.id, found.item.id));
    return c.json({ ok: true, deleted: !!found });
  })

  // ---- 買い物を終える・履歴 ----
  /**
   * カゴに入れた品物をリストから外し、買った記録に残す。
   * itemIds を送れば、そのうちカゴにあるものだけ（画面で見ていたものだけ。送り直しても二重にならない）
   */
  .post("/shopping-lists/:id/checkout", async (c) => {
    const { list, userId } = await loadList(c, c.req.param("id"));
    const { itemIds } = await body<{ itemIds: string[] }>(c);
    if (itemIds !== undefined && (!Array.isArray(itemIds) || itemIds.some((x) => typeof x !== "string"))) fail(400, "itemIds は品物の id の並びです");
    const db = c.get("db");
    const want = itemIds ? new Set(itemIds) : null;
    const rows = (
      await db
        .select({ item: shoppingItems, sectionName: shoppingSections.name })
        .from(shoppingItems)
        .leftJoin(shoppingSections, eq(shoppingItems.sectionId, shoppingSections.id))
        .where(and(eq(shoppingItems.listId, list.id), eq(shoppingItems.status, "in_cart")))
        .all()
    ).filter((r) => !want || want.has(r.item.id));
    if (rows.length === 0) return c.json({ purchased: 0, names: [] as string[] });
    const boughtAt = nowIso();
    const purchases = rows.map(({ item, sectionName }) => ({
      id: item.id,
      listId: list.id,
      familyId: list.familyId,
      name: item.name,
      note: item.note,
      sectionId: item.sectionId,
      sectionName,
      userId: item.cartBy ?? userId,
      boughtAt,
    }));
    const ids = rows.map((r) => r.item.id);
    const [first, ...rest] = [
      ...chunk(purchases, Math.floor(PARAMS_MAX / 9)).map((p) => db.insert(shoppingPurchases).values(p).onConflictDoNothing()),
      ...chunk(ids, PARAMS_MAX - 10).map((part) =>
        db.delete(shoppingItems).where(and(inArray(shoppingItems.id, part), eq(shoppingItems.listId, list.id), eq(shoppingItems.status, "in_cart"))),
      ),
    ];
    await db.batch([first!, ...rest]);
    return c.json({ purchased: rows.length, names: rows.map((r) => r.item.name) });
  })
  /** 買った記録（新しい順） */
  .get("/shopping-lists/:id/purchases", async (c) => {
    const { list } = await loadList(c, c.req.param("id"));
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
    const rows = await c
      .get("db")
      .select({
        id: shoppingPurchases.id,
        name: shoppingPurchases.name,
        note: shoppingPurchases.note,
        sectionId: shoppingPurchases.sectionId,
        sectionName: shoppingPurchases.sectionName,
        userName: users.displayName,
        boughtAt: shoppingPurchases.boughtAt,
      })
      .from(shoppingPurchases)
      .leftJoin(users, eq(shoppingPurchases.userId, users.id))
      .where(eq(shoppingPurchases.listId, list.id))
      .orderBy(desc(shoppingPurchases.boughtAt), asc(shoppingPurchases.name))
      .limit(limit)
      .all();
    return c.json(rows.map((r) => ({ ...r, listName: list.name })));
  });
