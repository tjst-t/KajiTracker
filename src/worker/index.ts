import { lt } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { authRoutes } from "./auth/routes";
import { purgeExpiredSessions } from "./auth/session";
import { DAY, isoBefore, nowIso } from "./context";
import type { AppEnv } from "./context";
import { getDb } from "./db";
import { loginTickets, rateLimits, webauthnChallenges } from "./db/schema";
import { apiGuard } from "./guards";

export const app = new Hono<AppEnv>().basePath("/api");

app.use("*", apiGuard);

app.get("/health", async (c) => {
  const row = await c.env.DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").first<{ n: number }>();
  return c.json({ ok: true, tables: row?.n ?? 0 });
});

app.route("/", authRoutes);

app.notFound((c) => c.json({ error: "その API はありません" }, 404));
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.json({ error: "サーバで問題が起きました" }, 500);
});

/** 期限の切れた challenge・札・回数制限の記録・セッションを消す */
export async function purge(env: Env) {
  const db = getDb(env.DB);
  await db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, nowIso()));
  await db.delete(loginTickets).where(lt(loginTickets.expiresAt, isoBefore(DAY)));
  await db.delete(rateLimits).where(lt(rateLimits.windowStart, Math.floor(Date.now() / 60_000) - 10));
  await purgeExpiredSessions(db);
}

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(purge(env));
    // 当日の通知（docs/design.md の 3）は「通知：Web Push と Cron」で足す
  },
} satisfies ExportedHandler<Env>;
