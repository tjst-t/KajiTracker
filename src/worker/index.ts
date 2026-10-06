import { Hono } from "hono";

export const app = new Hono<{ Bindings: Env }>().basePath("/api");

app.get("/health", async (c) => {
  const row = await c.env.DB.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").first<{ n: number }>();
  return c.json({ ok: true, tables: row?.n ?? 0 });
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, _env, _ctx) {
    // 当日の通知（docs/design.md の 3）。「通知：Web Push と Cron」で作る
  },
} satisfies ExportedHandler<Env>;
