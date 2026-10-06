// セッション（ログイン中の端末）。考え方は banto と同じ：
// 値はランダムな 256 bit、サーバには SHA-256 だけ。最後に使ってから30日で切れ、使えば延びる。
import { eq, lt } from "drizzle-orm";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Ctx, Site } from "../context";
import { DAY, HOUR, MINUTE, isoBefore, nowIso } from "../context";
import { passkeys, sessions, users } from "../db/schema";
import { randomToken, sha256Hex } from "../lib/crypto";
import { deviceLabel } from "../lib/device-label";

export const SESSION_TTL = 30 * DAY;
const TOUCH_EVERY = HOUR;
const STEP_UP_AFTER_PASSKEY = 5 * MINUTE;
const STEP_UP_AFTER_TICKET = 10 * MINUTE;

// https の画面では __Host-kaji-session（http の localhost では Secure を付けられないので kaji-session）
const COOKIE = "kaji-session";
const cookieOpts = (site: Site) => ({ path: "/", secure: site.secure, ...(site.secure ? { prefix: "host" as const } : {}) });

function writeCookie(c: Ctx, value: string) {
  setCookie(c, COOKIE, value, { ...cookieOpts(c.get("site")), httpOnly: true, sameSite: "Lax", maxAge: SESSION_TTL / 1000 });
}

function cookieValue(c: Ctx): string | undefined {
  return c.get("site").secure ? getCookie(c, COOKIE, "host") : getCookie(c, COOKIE);
}

type Via = (typeof sessions.$inferSelect)["via"];

export async function createSession(c: Ctx, userId: string, via: Via, opts: { issuedByUserId?: string | null; stepUp?: boolean } = {}) {
  const token = randomToken();
  const now = nowIso();
  const row = {
    id: await sha256Hex(token),
    userId,
    via,
    issuedByUserId: opts.issuedByUserId ?? null,
    deviceLabel: deviceLabel(c.req.header("User-Agent")),
    stepUpAt: opts.stepUp ? now : null,
    createdAt: now,
    lastUsedAt: now,
  };
  await c.get("db").insert(sessions).values(row);
  writeCookie(c, token);
  return row;
}

/** Cookie からセッションを読み、c.set("auth") する。無ければ null */
export async function loadSession(c: Ctx): Promise<void> {
  c.set("auth", null);
  const token = cookieValue(c);
  if (!token) return;
  const db = c.get("db");
  const id = await sha256Hex(token);
  const row = await db.select().from(sessions).innerJoin(users, eq(sessions.userId, users.id)).where(eq(sessions.id, id)).get();
  if (!row) return;
  if (row.sessions.lastUsedAt < isoBefore(SESSION_TTL)) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return;
  }
  if (row.sessions.lastUsedAt < isoBefore(TOUCH_EVERY)) {
    const now = nowIso();
    await db.update(sessions).set({ lastUsedAt: now }).where(eq(sessions.id, id));
    row.sessions.lastUsedAt = now;
    writeCookie(c, token); // Cookie の期限も延ばす
  }
  c.set("auth", { user: row.users, session: row.sessions });
}

export async function endSession(c: Ctx, sessionId: string) {
  await c.get("db").delete(sessions).where(eq(sessions.id, sessionId));
  deleteCookie(c, COOKIE, cookieOpts(c.get("site")));
}

/**
 * 大事な操作の前の本人確認（step-up）が済んでいるか。
 * - パスキーで通してから5分
 * - 札で入ってから10分（札を出す側がパスキーを通しているため。足したばかりの端末がパスキーを登録できるように）
 * - パスキーがまだ1つも無い
 */
export async function stepUpSatisfied(c: Ctx, session: typeof sessions.$inferSelect): Promise<boolean> {
  if (session.stepUpAt && session.stepUpAt >= isoBefore(STEP_UP_AFTER_PASSKEY)) return true;
  if (session.via !== "passkey" && session.createdAt >= isoBefore(STEP_UP_AFTER_TICKET)) return true;
  const any = await c.get("db").select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, session.userId)).limit(1).get();
  return !any;
}

/** 古いセッションの掃除（Cron から） */
export async function purgeExpiredSessions(db: Ctx["var"]["db"]) {
  await db.delete(sessions).where(lt(sessions.lastUsedAt, isoBefore(SESSION_TTL)));
}
