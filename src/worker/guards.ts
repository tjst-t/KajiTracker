import { sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { AppEnv, Ctx, Site } from "./context";
import { fail } from "./context";
import { getDb } from "./db";
import { rateLimits } from "./db/schema";
import { loadSession } from "./auth/session";

function parseOrigins(raw: string): Site[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((origin) => {
      const u = new URL(origin);
      return { origin: u.origin, rpId: u.hostname, secure: u.protocol === "https:" };
    });
}

/**
 * どの画面から来たかを決め、よその画面からの要求を断る。
 * - Origin ヘッダがあれば ORIGINS のどれかと一致しなければ断る（パスキーの検証でもこのオリジン1つに固定する）
 * - Origin が無ければ（GET など）要求の URL、それも違えば ORIGINS の先頭
 * - Cookie で来る要求の CSRF 対策として、独自ヘッダ X-Kaji-Client: 1 を求める
 */
export const apiGuard = createMiddleware<AppEnv>(async (c, next) => {
  const sites = parseOrigins(c.env.ORIGINS);
  const originHeader = c.req.header("Origin");
  let site: Site | undefined;
  if (originHeader) {
    site = sites.find((s) => s.origin === originHeader);
    if (!site) fail(403, "この画面からは使えません", "bad_origin");
  } else {
    site = sites.find((s) => s.origin === new URL(c.req.url).origin) ?? sites[0];
  }
  if (!site) fail(500, "ORIGINS が設定されていません");
  c.set("site", site);
  c.set("db", getDb(c.env.DB));

  if (c.req.path !== "/api/health" && c.req.header("X-Kaji-Client") !== "1") {
    fail(403, "画面から使ってください", "missing_client_header");
  }

  await loadSession(c);
  await next();
  c.header("Cache-Control", "no-store");
});

/** 認証の要らない口の回数制限（1分あたり） */
export async function rateLimit(c: Ctx, name: string, perMinute: number) {
  const ip = c.req.header("CF-Connecting-IP") ?? "local";
  const key = `${name}:${ip}`;
  const windowStart = Math.floor(Date.now() / 60_000);
  const row = await c
    .get("db")
    .insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: sql`${rateLimits.count} + 1` } })
    .returning({ count: rateLimits.count })
    .get();
  if (row.count > perMinute) fail(429, "回数が多すぎます。1分ほど待ってからやり直してください", "rate_limited");
}
