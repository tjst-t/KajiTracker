// Family・招待・回復の札。仕様は docs/spec.md「Family」「全部の端末をなくしたとき」。
import { type RegistrationResponseJSON, generateRegistrationOptions } from "@simplewebauthn/server";
import { and, asc, count, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { RP, TICKET_TTL, body, requireStepUp, saveChallenge, takeChallengeRow, validDisplayName, verifyNewPasskey } from "../auth/routes";
import { createSession } from "../auth/session";
import type { AppEnv, Ctx } from "../context";
import { DAY, fail, isoAfter, nowIso, requireAuth } from "../context";
import { choreGroups, chores, families, familyMembers, invites, loginTickets, passkeys, users } from "../db/schema";
import { rateLimit } from "../guards";
import { base64urlToBytes, newId, randomToken, sha256Hex } from "../lib/crypto";

const INVITE_TTL = DAY;
/** Family を作ったときに最初からあるグループ */
export const DEFAULT_GROUPS = ["キッチン", "風呂", "トイレ", "洗濯", "ゴミ捨て", "掃除"];
type Role = "admin" | "member";

const validFamilyName = (s: string | undefined): s is string => !!s && [...s].length >= 1 && [...s].length <= 30;

/** その Family のメンバーでなければ 404（よその Family があるかどうかも見せない） */
export async function requireMember(c: Ctx, familyId: string): Promise<{ userId: string; role: Role }> {
  const { user } = requireAuth(c);
  const m = await c
    .get("db")
    .select({ role: familyMembers.role })
    .from(familyMembers)
    .where(and(eq(familyMembers.familyId, familyId), eq(familyMembers.userId, user.id)))
    .get();
  if (!m) fail(404, "その Family はありません", "family_not_found");
  return { userId: user.id, role: m.role };
}

async function requireAdmin(c: Ctx, familyId: string) {
  const m = await requireMember(c, familyId);
  if (m.role !== "admin") fail(403, "管理者だけができる操作です", "admin_only");
  return m;
}

async function adminCount(c: Ctx, familyId: string) {
  const r = await c
    .get("db")
    .select({ n: count() })
    .from(familyMembers)
    .where(and(eq(familyMembers.familyId, familyId), eq(familyMembers.role, "admin")))
    .get();
  return r?.n ?? 0;
}

async function memberCount(c: Ctx, familyId: string) {
  const r = await c.get("db").select({ n: count() }).from(familyMembers).where(eq(familyMembers.familyId, familyId)).get();
  return r?.n ?? 0;
}

/** Family から1人を外す（抜ける・外す共通）。担当だった家事は「担当なし」に戻す。記録は残す */
async function removeMember(c: Ctx, familyId: string, userId: string) {
  const db = c.get("db");
  await db.batch([
    db.update(chores).set({ assigneeUserId: null }).where(and(eq(chores.familyId, familyId), eq(chores.assigneeUserId, userId))),
    db.delete(familyMembers).where(and(eq(familyMembers.familyId, familyId), eq(familyMembers.userId, userId))),
  ]);
}

/** 招待の値から、まだ使える招待と Family を引く */
async function findInvite(c: Ctx, token: string | undefined) {
  if (!token) fail(400, "招待がありません");
  const row = await c
    .get("db")
    .select({ invite: invites, familyName: families.name, inviter: users.displayName })
    .from(invites)
    .innerJoin(families, eq(invites.familyId, families.id))
    .innerJoin(users, eq(invites.createdBy, users.id))
    .where(eq(invites.id, await sha256Hex(token)))
    .get();
  if (!row || row.invite.usedAt || row.invite.expiresAt < nowIso()) return null;
  return row;
}

/** 招待を使ったことにする（同時に2回使えないよう、条件つきの UPDATE で）。使えなければ fail */
async function consumeInvite(c: Ctx, token: string, userId: string) {
  const r = await c
    .get("db")
    .update(invites)
    .set({ usedAt: nowIso(), usedBy: userId })
    .where(and(eq(invites.id, await sha256Hex(token)), isNull(invites.usedAt), gt(invites.expiresAt, nowIso())))
    .returning()
    .get();
  if (!r) fail(400, "この招待は使えません。期限（24時間）が切れたか、もう使われています", "invite_invalid");
  return r;
}

const INVITE_GONE = "この招待は使えません。期限（24時間）が切れたか、もう使われています";

export const familyRoutes = new Hono<AppEnv>()
  // ---- 自分の Family ----
  .get("/families", async (c) => {
    const { user } = requireAuth(c);
    const db = c.get("db");
    const mine = await db
      .select({ id: families.id, name: families.name, role: familyMembers.role })
      .from(familyMembers)
      .innerJoin(families, eq(familyMembers.familyId, families.id))
      .where(eq(familyMembers.userId, user.id))
      .orderBy(asc(familyMembers.joinedAt))
      .all();
    return c.json(mine);
  })
  .post("/families", async (c) => {
    const { user } = requireAuth(c);
    const { name } = await body<{ name: string }>(c);
    const n = name?.trim();
    if (!validFamilyName(n)) fail(400, "Family の名前を1〜30文字で入れてください");
    const id = newId();
    const db = c.get("db");
    await db.batch([
      db.insert(families).values({ id, name: n }),
      db.insert(familyMembers).values({ familyId: id, userId: user.id, role: "admin" }),
      db.insert(choreGroups).values(DEFAULT_GROUPS.map((name, i) => ({ id: newId(), familyId: id, name, sortOrder: i }))),
    ]);
    return c.json({ id, name: n, role: "admin" as Role }, 201);
  })
  .patch("/families/:fid", async (c) => {
    const fid = c.req.param("fid");
    await requireAdmin(c, fid);
    const { name } = await body<{ name: string }>(c);
    const n = name?.trim();
    if (!validFamilyName(n)) fail(400, "Family の名前を1〜30文字で入れてください");
    await c.get("db").update(families).set({ name: n }).where(eq(families.id, fid));
    return c.json({ id: fid, name: n });
  })
  .delete("/families/:fid", async (c) => {
    const fid = c.req.param("fid");
    await requireAdmin(c, fid);
    const { confirmName } = await body<{ confirmName: string }>(c);
    const f = await c.get("db").select().from(families).where(eq(families.id, fid)).get();
    if (!f || confirmName?.trim() !== f.name) fail(400, "確認のため、Family の名前をそのまま入れてください", "confirm_name_mismatch");
    await requireStepUp(c);
    // 家事・記録・招待・メンバーは外部キーの cascade で消える
    await c.get("db").delete(families).where(eq(families.id, fid));
    return c.json({ ok: true });
  })

  // ---- メンバー ----
  .get("/families/:fid/members", async (c) => {
    const fid = c.req.param("fid");
    const me = await requireMember(c, fid);
    const rows = await c
      .get("db")
      .select({ userId: users.id, displayName: users.displayName, role: familyMembers.role, joinedAt: familyMembers.joinedAt })
      .from(familyMembers)
      .innerJoin(users, eq(familyMembers.userId, users.id))
      .where(eq(familyMembers.familyId, fid))
      .orderBy(asc(familyMembers.joinedAt))
      .all();
    return c.json(rows.map((r) => ({ ...r, isMe: r.userId === me.userId })));
  })
  .patch("/families/:fid/members/:uid", async (c) => {
    const fid = c.req.param("fid");
    const uid = c.req.param("uid");
    await requireAdmin(c, fid);
    const { role } = await body<{ role: Role }>(c);
    if (role !== "admin" && role !== "member") fail(400, "役割は admin か member です");
    const db = c.get("db");
    const target = await db.select().from(familyMembers).where(and(eq(familyMembers.familyId, fid), eq(familyMembers.userId, uid))).get();
    if (!target) fail(404, "その人はこの Family にいません");
    if (target.role === "admin" && role === "member" && (await adminCount(c, fid)) <= 1) {
      fail(409, "管理者が1人もいなくなります。先にほかの人を管理者にしてください", "last_admin");
    }
    await db.update(familyMembers).set({ role }).where(and(eq(familyMembers.familyId, fid), eq(familyMembers.userId, uid)));
    return c.json({ ok: true });
  })
  /** 自分なら「抜ける」、ほかの人なら「外す」（管理者だけ） */
  .delete("/families/:fid/members/:uid", async (c) => {
    const fid = c.req.param("fid");
    const uid = c.req.param("uid");
    const me = await requireMember(c, fid);
    const db = c.get("db");
    if (uid !== me.userId) {
      if (me.role !== "admin") fail(403, "管理者だけができる操作です", "admin_only");
      const target = await db.select().from(familyMembers).where(and(eq(familyMembers.familyId, fid), eq(familyMembers.userId, uid))).get();
      if (!target) fail(404, "その人はこの Family にいません");
      await removeMember(c, fid, uid);
      return c.json({ ok: true, familyDeleted: false });
    }
    // 抜ける
    const members = await memberCount(c, fid);
    if (members <= 1) {
      // 1人だけの Family から抜けると、Family の削除になる
      await db.delete(families).where(eq(families.id, fid));
      return c.json({ ok: true, familyDeleted: true });
    }
    if (me.role === "admin" && (await adminCount(c, fid)) <= 1) {
      fail(409, "あなたは最後の管理者です。抜ける前に、ほかの人を管理者にしてください", "last_admin");
    }
    await removeMember(c, fid, uid);
    return c.json({ ok: true, familyDeleted: false });
  })

  // ---- 回復の札：管理者が、端末をなくしたメンバーのために出す ----
  .post("/families/:fid/members/:uid/recovery-ticket", async (c) => {
    const fid = c.req.param("fid");
    const uid = c.req.param("uid");
    const me = await requireAdmin(c, fid);
    if (uid === me.userId) fail(400, "自分のための札は「設定」の「端末を追加」で出してください");
    const db = c.get("db");
    const target = await db.select().from(familyMembers).where(and(eq(familyMembers.familyId, fid), eq(familyMembers.userId, uid))).get();
    if (!target) fail(404, "その人はこの Family にいません");
    await requireStepUp(c);
    const token = randomToken();
    const id = await sha256Hex(token);
    const expiresAt = isoAfter(TICKET_TTL);
    await db.insert(loginTickets).values({ id, kind: "recovery", userId: uid, issuedByUserId: me.userId, expiresAt });
    return c.json({ id, url: `${c.get("site").origin}/#login=${token}`, expiresAt });
  })

  // ---- 招待 ----
  .post("/families/:fid/invites", async (c) => {
    const fid = c.req.param("fid");
    const me = await requireAdmin(c, fid);
    const token = randomToken();
    const id = await sha256Hex(token);
    const expiresAt = isoAfter(INVITE_TTL);
    await c.get("db").insert(invites).values({ id, familyId: fid, createdBy: me.userId, expiresAt });
    return c.json({ id, url: `${c.get("site").origin}/#invite=${token}`, expiresAt }, 201);
  })
  /** 出した招待が使われたか（招待した人の画面に「○○さんが入りました」を出す） */
  .get("/families/:fid/invites/:id", async (c) => {
    const fid = c.req.param("fid");
    await requireAdmin(c, fid);
    const row = await c
      .get("db")
      .select({ invite: invites, usedByName: users.displayName })
      .from(invites)
      .leftJoin(users, eq(invites.usedBy, users.id))
      .where(and(eq(invites.id, c.req.param("id")), eq(invites.familyId, fid)))
      .get();
    if (!row) fail(404, "その招待はありません");
    return c.json({ used: !!row.invite.usedAt, usedByName: row.usedByName, expired: !row.invite.usedAt && row.invite.expiresAt < nowIso() });
  })

  /** 招待の中身を見る（ログインしていなくても） */
  .post("/invites/info", async (c) => {
    await rateLimit(c, "invite", 20);
    const { token } = await body<{ token: string }>(c);
    const row = await findInvite(c, token);
    if (!row) return c.json({ valid: false as const });
    const auth = c.get("auth");
    let alreadyMember = false;
    if (auth) {
      const m = await c
        .get("db")
        .select()
        .from(familyMembers)
        .where(and(eq(familyMembers.familyId, row.invite.familyId), eq(familyMembers.userId, auth.user.id)))
        .get();
      alreadyMember = !!m;
    }
    return c.json({ valid: true as const, familyId: row.invite.familyId, familyName: row.familyName, invitedBy: row.inviter, alreadyMember });
  })
  /** ログイン済みの人が招待で入る */
  .post("/invites/accept", async (c) => {
    const { user } = requireAuth(c);
    await rateLimit(c, "invite", 20);
    const { token } = await body<{ token: string }>(c);
    const row = await findInvite(c, token);
    if (!row) fail(400, INVITE_GONE, "invite_invalid");
    const db = c.get("db");
    const already = await db
      .select()
      .from(familyMembers)
      .where(and(eq(familyMembers.familyId, row.invite.familyId), eq(familyMembers.userId, user.id)))
      .get();
    if (already) fail(409, "もうこの Family に入っています", "already_member");
    await consumeInvite(c, token!, user.id);
    await db.insert(familyMembers).values({ familyId: row.invite.familyId, userId: user.id, role: "member" });
    return c.json({ familyId: row.invite.familyId, familyName: row.familyName });
  })
  /** 初めての人：名前を受け取り、パスキーを作る準備（ユーザーはまだ作らない） */
  .post("/invites/register/options", async (c) => {
    await rateLimit(c, "invite", 20);
    const { token, displayName } = await body<{ token: string; displayName: string }>(c);
    const row = await findInvite(c, token);
    if (!row) fail(400, INVITE_GONE, "invite_invalid");
    const name = displayName?.trim();
    if (!validDisplayName(name)) fail(400, "名前を1〜20文字で入れてください", "display_name_required");
    const pending = { userId: newId(), webauthnUserId: randomToken(32), displayName: name, inviteId: row.invite.id };
    const opts = await generateRegistrationOptions({
      rpName: RP.name,
      rpID: c.get("site").rpId,
      userID: base64urlToBytes(pending.webauthnUserId),
      userName: name,
      userDisplayName: name,
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    await saveChallenge(c, opts.challenge, "register", null, pending);
    return c.json(opts);
  })
  /** 初めての人：パスキーを確かめてから、招待を使い、ユーザー・パスキー・メンバーを作ってログインさせる */
  .post("/invites/register/verify", async (c) => {
    await rateLimit(c, "invite", 20);
    const { token, response, passkeyName } = await body<{ token: string; response: RegistrationResponseJSON; passkeyName: string }>(c);
    const chal = await takeChallengeRow(c, "register", null);
    const pending = chal.data ? (JSON.parse(chal.data) as { userId: string; webauthnUserId: string; displayName: string; inviteId: string }) : null;
    if (!pending || !token || pending.inviteId !== (await sha256Hex(token))) fail(400, "やり直してください", "challenge_invalid");
    const pk = await verifyNewPasskey(c, response, chal.challenge, pending.userId, passkeyName);
    const db = c.get("db");
    // ユーザーを先に作り、そのあと招待を使う（使えなければユーザーを消す）
    await db.insert(users).values({ id: pending.userId, displayName: pending.displayName, webauthnUserId: pending.webauthnUserId });
    let invite;
    try {
      invite = await consumeInvite(c, token, pending.userId);
    } catch (e) {
      await db.delete(users).where(eq(users.id, pending.userId));
      throw e;
    }
    await db.batch([
      db.insert(passkeys).values(pk),
      db.insert(familyMembers).values({ familyId: invite.familyId, userId: pending.userId, role: "member" }),
    ]);
    await createSession(c, pending.userId, "passkey", { stepUp: true });
    return c.json({ familyId: invite.familyId });
  });

