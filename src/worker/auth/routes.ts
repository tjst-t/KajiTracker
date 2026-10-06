// ログインの API。仕様は docs/spec.md「アカウントとログイン」、口の一覧は docs/design.md の 5。
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Ctx } from "../context";
import { MINUTE, fail, isoAfter, nowIso, requireAuth } from "../context";
import { loginTickets, passkeys, sessions, users, webauthnChallenges } from "../db/schema";
import { rateLimit } from "../guards";
import { base64urlToBytes, bytesToBase64url, newId, randomToken, sha256Hex } from "../lib/crypto";
import { deviceLabel } from "../lib/device-label";
import { createSession, endSession, stepUpSatisfied } from "./session";

const RP_NAME = "KajiTracker";
const CHALLENGE_TTL = 5 * MINUTE;
export const TICKET_TTL = 10 * MINUTE;

// ---- challenge（パスキーの1回ごとの乱数）。行の id を短命の Cookie で画面に持たせる ----

const CHAL_COOKIE = "kaji-chal";
const chalCookieOpts = (c: Ctx) => ({ path: "/", secure: c.get("site").secure, ...(c.get("site").secure ? { prefix: "host" as const } : {}) });

export async function saveChallenge(
  c: Ctx,
  challenge: string,
  purpose: "register" | "authenticate" | "step_up",
  userId: string | null,
  data?: unknown,
) {
  const id = newId();
  await c
    .get("db")
    .insert(webauthnChallenges)
    .values({ id, challenge, purpose, userId, data: data === undefined ? null : JSON.stringify(data), expiresAt: isoAfter(CHALLENGE_TTL) });
  setCookie(c, CHAL_COOKIE, id, { ...chalCookieOpts(c), httpOnly: true, sameSite: "Strict", maxAge: CHALLENGE_TTL / 1000 });
}

/** challenge を取り出して消す（1回だけ使える） */
export async function takeChallengeRow(c: Ctx, purpose: "register" | "authenticate" | "step_up", userId: string | null) {
  const id = c.get("site").secure ? getCookie(c, CHAL_COOKIE, "host") : getCookie(c, CHAL_COOKIE);
  deleteCookie(c, CHAL_COOKIE, chalCookieOpts(c));
  if (!id) fail(400, "やり直してください（確認の期限が切れました）", "challenge_missing");
  const row = await c.get("db").delete(webauthnChallenges).where(eq(webauthnChallenges.id, id)).returning().get();
  if (!row || row.purpose !== purpose || row.userId !== userId || row.expiresAt < nowIso()) {
    fail(400, "やり直してください（確認の期限が切れました）", "challenge_invalid");
  }
  return row;
}

async function takeChallenge(c: Ctx, purpose: "register" | "authenticate" | "step_up", userId: string | null): Promise<string> {
  return (await takeChallengeRow(c, purpose, userId)).challenge;
}

export async function requireStepUp(c: Ctx) {
  const { session } = requireAuth(c);
  if (!(await stepUpSatisfied(c, session))) fail(403, "パスキーでもう一度確認してください", "step_up_required");
}

export async function body<T>(c: Ctx): Promise<Partial<T>> {
  try {
    return (await c.req.json()) as Partial<T>;
  } catch {
    return {};
  }
}

function credentialOf(p: typeof passkeys.$inferSelect) {
  return {
    id: p.id,
    publicKey: base64urlToBytes(p.publicKey),
    counter: p.counter,
    transports: p.transports ? (JSON.parse(p.transports) as AuthenticatorTransport[]) : undefined,
  };
}

/** パスキーの応答を確かめ、通ったパスキーを返す（署名回数と最後に使った時刻を更新） */
async function verifyAssertion(c: Ctx, response: AuthenticationResponseJSON | undefined, expectedChallenge: string, mustBelongTo?: string) {
  if (!response?.id) fail(400, "パスキーの応答がありません");
  const db = c.get("db");
  const pk = await db.select().from(passkeys).where(eq(passkeys.id, response.id)).get();
  if (!pk || (mustBelongTo && pk.userId !== mustBelongTo)) fail(401, "このパスキーは登録されていません", "unknown_passkey");
  const site = c.get("site");
  let verified = false;
  let newCounter = pk.counter;
  try {
    const r = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: site.origin,
      expectedRPID: site.rpId,
      credential: credentialOf(pk),
      requireUserVerification: true,
    });
    verified = r.verified;
    newCounter = r.authenticationInfo.newCounter;
  } catch (e) {
    console.warn("passkey verify failed", e);
  }
  if (!verified) fail(401, "パスキーを確かめられませんでした", "passkey_failed");
  // 署名回数は複製の検出に使わない（同期するパスキーは 0 を返す）。記録だけする
  await db.update(passkeys).set({ counter: newCounter, lastUsedAt: nowIso() }).where(eq(passkeys.id, pk.id));
  return pk;
}

/** 新しいパスキーの応答を確かめ、passkeys に入れる行を返す（まだ入れない） */
export async function verifyNewPasskey(c: Ctx, response: RegistrationResponseJSON | undefined, challenge: string, userId: string, name?: string) {
  if (!response) fail(400, "パスキーの応答がありません");
  const site = c.get("site");
  let info;
  try {
    const r = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: site.origin,
      expectedRPID: site.rpId,
      requireUserVerification: true,
    });
    info = r.verified ? r.registrationInfo : undefined;
  } catch (e) {
    console.warn("passkey register failed", e);
  }
  if (!info) fail(400, "パスキーを登録できませんでした", "passkey_failed");
  return {
    id: info.credential.id,
    userId,
    publicKey: bytesToBase64url(info.credential.publicKey),
    counter: info.credential.counter,
    transports: JSON.stringify(response.response.transports ?? []),
    name: name?.trim().slice(0, 40) || deviceLabel(c.req.header("User-Agent")),
  };
}

export const RP = { name: RP_NAME };

const meOf = async (c: Ctx) => {
  const { user, session } = requireAuth(c);
  const count = (await c.get("db").select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, user.id)).all()).length;
  return {
    user: { id: user.id, displayName: user.displayName, notifyTime: user.notifyTime },
    session: { id: session.id, via: session.via, stepUpOk: await stepUpSatisfied(c, session) },
    passkeyCount: count,
  };
};

export const authRoutes = new Hono<AppEnv>()
  // ---- パスキーでログイン ----
  .post("/auth/login/options", async (c) => {
    await rateLimit(c, "login", 30);
    const opts = await generateAuthenticationOptions({ rpID: c.get("site").rpId, userVerification: "required", allowCredentials: [] });
    await saveChallenge(c, opts.challenge, "authenticate", null);
    return c.json(opts);
  })
  .post("/auth/login/verify", async (c) => {
    await rateLimit(c, "login", 30);
    const { response } = await body<{ response: AuthenticationResponseJSON }>(c);
    const challenge = await takeChallenge(c, "authenticate", null);
    const pk = await verifyAssertion(c, response, challenge);
    await createSession(c, pk.userId, "passkey", { stepUp: true });
    return c.json({ ok: true });
  })

  // ---- 札（端末を追加・回復・最初の1人） ----
  .post("/auth/ticket-info", async (c) => {
    await rateLimit(c, "ticket-info", 30);
    const { token } = await body<{ token: string }>(c);
    if (!token) fail(400, "札がありません");
    const t = await c.get("db").select().from(loginTickets).where(eq(loginTickets.id, await sha256Hex(token))).get();
    if (!t || t.usedAt || t.expiresAt < nowIso()) return c.json({ valid: false as const });
    return c.json({ valid: true as const, kind: t.kind });
  })
  .post("/auth/redeem", async (c) => {
    await rateLimit(c, "redeem", 10);
    const { token, displayName } = await body<{ token: string; displayName: string }>(c);
    if (!token) fail(400, "札がありません");
    const db = c.get("db");
    const id = await sha256Hex(token);
    const peek = await db.select().from(loginTickets).where(eq(loginTickets.id, id)).get();
    const name = displayName?.trim();
    if (peek?.kind === "bootstrap" && !validDisplayName(name)) fail(400, "名前を1〜20文字で入れてください", "display_name_required");

    // 使ったことにする（同時に2回引き換えられないよう、条件つきの UPDATE で）
    const t = await db
      .update(loginTickets)
      .set({ usedAt: nowIso(), usedDeviceLabel: deviceLabel(c.req.header("User-Agent")) })
      .where(and(eq(loginTickets.id, id), isNull(loginTickets.usedAt), gt(loginTickets.expiresAt, nowIso())))
      .returning()
      .get();
    if (!t) fail(400, "この札は使えません。期限（10分）が切れたか、もう使われています", "ticket_invalid");

    let userId = t.userId;
    if (t.kind === "bootstrap") {
      userId = newId();
      await db.insert(users).values({ id: userId, displayName: name!, webauthnUserId: randomToken(32) });
    }
    if (!userId) fail(400, "この札は使えません", "ticket_invalid");
    const via = t.kind === "device" ? "device_ticket" : t.kind === "recovery" ? "recovery_ticket" : "bootstrap";
    await createSession(c, userId, via, { issuedByUserId: t.kind === "recovery" ? t.issuedByUserId : null });
    return c.json({ ok: true });
  })

  // ---- パスキーを足す ----
  .post("/auth/register/options", async (c) => {
    const { user } = requireAuth(c);
    await requireStepUp(c);
    const mine = await c.get("db").select().from(passkeys).where(eq(passkeys.userId, user.id)).all();
    const opts = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: c.get("site").rpId,
      userID: base64urlToBytes(user.webauthnUserId),
      userName: user.displayName,
      userDisplayName: user.displayName,
      attestationType: "none",
      excludeCredentials: mine.map((p) => ({ id: p.id, transports: credentialOf(p).transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    await saveChallenge(c, opts.challenge, "register", user.id);
    return c.json(opts);
  })
  .post("/auth/register/verify", async (c) => {
    const { user } = requireAuth(c);
    const { response, name } = await body<{ response: RegistrationResponseJSON; name: string }>(c);
    const challenge = await takeChallenge(c, "register", user.id);
    const row = await verifyNewPasskey(c, response, challenge, user.id, name);
    await c.get("db").insert(passkeys).values(row);
    return c.json({ id: row.id, name: row.name });
  })

  // ---- 大事な操作の前の確認（step-up） ----
  .post("/auth/step-up/options", async (c) => {
    const { user } = requireAuth(c);
    const mine = await c.get("db").select().from(passkeys).where(eq(passkeys.userId, user.id)).all();
    if (mine.length === 0) fail(400, "パスキーがまだありません", "no_passkey");
    const opts = await generateAuthenticationOptions({
      rpID: c.get("site").rpId,
      userVerification: "required",
      allowCredentials: mine.map((p) => ({ id: p.id, transports: credentialOf(p).transports })),
    });
    await saveChallenge(c, opts.challenge, "step_up", user.id);
    return c.json(opts);
  })
  .post("/auth/step-up/verify", async (c) => {
    const { user, session } = requireAuth(c);
    const { response } = await body<{ response: AuthenticationResponseJSON }>(c);
    const challenge = await takeChallenge(c, "step_up", user.id);
    await verifyAssertion(c, response, challenge, user.id);
    await c.get("db").update(sessions).set({ stepUpAt: nowIso() }).where(eq(sessions.id, session.id));
    return c.json({ ok: true });
  })

  .post("/auth/logout", async (c) => {
    const auth = c.get("auth");
    if (auth) await endSession(c, auth.session.id);
    return c.json({ ok: true });
  })

  // ---- 自分 ----
  .get("/me", async (c) => c.json(await meOf(c)))
  .patch("/me", async (c) => {
    const { user } = requireAuth(c);
    const { displayName, notifyTime } = await body<{ displayName: string; notifyTime: string }>(c);
    const set: Partial<typeof users.$inferInsert> = {};
    if (displayName !== undefined) {
      if (!validDisplayName(displayName.trim())) fail(400, "名前は1〜20文字です");
      set.displayName = displayName.trim();
    }
    if (notifyTime !== undefined) {
      if (!validNotifyTime(notifyTime)) fail(400, "通知の時刻は 15 分きざみ（例 20:00、07:15）で選んでください");
      set.notifyTime = notifyTime;
    }
    if (Object.keys(set).length) await c.get("db").update(users).set(set).where(eq(users.id, user.id));
    const fresh = await c.get("db").select().from(users).where(eq(users.id, user.id)).get();
    c.set("auth", { ...requireAuth(c), user: fresh! });
    return c.json(await meOf(c));
  })

  .get("/me/passkeys", async (c) => {
    const { user } = requireAuth(c);
    const rows = await c.get("db").select().from(passkeys).where(eq(passkeys.userId, user.id)).orderBy(desc(passkeys.createdAt)).all();
    return c.json(rows.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })));
  })
  .delete("/me/passkeys/:id", async (c) => {
    const { user } = requireAuth(c);
    await requireStepUp(c);
    const r = await c.get("db").delete(passkeys).where(and(eq(passkeys.id, c.req.param("id")), eq(passkeys.userId, user.id))).returning().get();
    if (!r) fail(404, "そのパスキーはありません");
    return c.json({ ok: true });
  })

  .get("/me/sessions", async (c) => {
    const { user, session } = requireAuth(c);
    const rows = await c
      .get("db")
      .select({ s: sessions, issuer: users.displayName })
      .from(sessions)
      .leftJoin(users, eq(sessions.issuedByUserId, users.id))
      .where(eq(sessions.userId, user.id))
      .orderBy(desc(sessions.lastUsedAt))
      .all();
    return c.json(
      rows.map(({ s, issuer }) => ({
        id: s.id,
        deviceLabel: s.deviceLabel,
        via: s.via,
        issuedBy: issuer,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        current: s.id === session.id,
      })),
    );
  })
  .delete("/me/sessions/:id", async (c) => {
    const { user, session } = requireAuth(c);
    const id = c.req.param("id");
    if (id === session.id) {
      await endSession(c, id);
      return c.json({ ok: true });
    }
    await requireStepUp(c);
    const r = await c.get("db").delete(sessions).where(and(eq(sessions.id, id), eq(sessions.userId, user.id))).returning().get();
    if (!r) fail(404, "その端末はありません");
    return c.json({ ok: true });
  })

  // ---- 端末を追加：QR とリンクの札を出す ----
  .post("/me/device-tickets", async (c) => {
    const { user } = requireAuth(c);
    await requireStepUp(c);
    const token = randomToken();
    const id = await sha256Hex(token);
    const expiresAt = isoAfter(TICKET_TTL);
    await c.get("db").insert(loginTickets).values({ id, kind: "device", userId: user.id, issuedByUserId: user.id, expiresAt });
    return c.json({ id, url: `${c.get("site").origin}/#login=${token}`, expiresAt });
  })
  // 自分が出した札（端末を追加・回復）が使われたか
  .get("/me/tickets/:id", async (c) => {
    const { user } = requireAuth(c);
    const t = await c
      .get("db")
      .select()
      .from(loginTickets)
      .where(and(eq(loginTickets.id, c.req.param("id")), eq(loginTickets.issuedByUserId, user.id)))
      .get();
    if (!t) fail(404, "その札はありません");
    return c.json({ used: !!t.usedAt, deviceLabel: t.usedDeviceLabel, expired: !t.usedAt && t.expiresAt < nowIso() });
  });

export function validDisplayName(s: string | undefined): s is string {
  return !!s && [...s].length >= 1 && [...s].length <= 20;
}

export function validNotifyTime(s: string): boolean {
  return /^([01]\d|2[0-3]):(00|15|30|45)$/.test(s);
}
