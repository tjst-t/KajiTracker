// 通知の購読。仕様は docs/spec.md「通知」、設計は docs/design.md の 3・5
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { body } from "../auth/routes";
import type { AppEnv } from "../context";
import { fail, requireAuth } from "../context";
import { pushSubscriptions } from "../db/schema";
import { newId } from "../lib/crypto";
import { deviceLabel } from "../lib/device-label";

type SubscriptionBody = { endpoint: string; keys: { p256dh?: string; auth?: string } };

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/** プッシュの宛先は https の URL だけ */
function validEndpoint(s: unknown): s is string {
  if (typeof s !== "string" || s.length > 2048) return false;
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}

const validKey = (s: unknown, max: number): s is string => typeof s === "string" && s.length > 0 && s.length <= max && BASE64URL.test(s);

export const pushRoutes = new Hono<AppEnv>()
  /** 画面が購読を作るときに使う公開鍵 */
  .get("/push/vapid-public-key", (c) => {
    requireAuth(c);
    return c.json({ publicKey: c.env.VAPID_PUBLIC_KEY });
  })
  /** この端末で通知を受ける。同じ endpoint があれば上書きする（ほかの人のものでも、いまログインしている人のものにする） */
  .post("/push/subscriptions", async (c) => {
    const { user } = requireAuth(c);
    const { endpoint, keys } = await body<SubscriptionBody>(c);
    if (!validEndpoint(endpoint) || !validKey(keys?.p256dh, 200) || !validKey(keys?.auth, 100)) {
      fail(400, "通知の登録に必要な情報が足りません", "subscription_invalid");
    }
    const row = { userId: user.id, p256dh: keys.p256dh, auth: keys.auth, deviceLabel: deviceLabel(c.req.header("User-Agent")) };
    await c
      .get("db")
      .insert(pushSubscriptions)
      .values({ id: newId(), endpoint, ...row })
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { ...row, lastSuccessAt: null } });
    return c.json({ ok: true });
  })
  /** この端末で通知を受けるのをやめる（自分の購読だけ消せる） */
  .delete("/push/subscriptions", async (c) => {
    const { user } = requireAuth(c);
    const { endpoint } = await body<{ endpoint: string }>(c);
    if (typeof endpoint !== "string" || !endpoint) fail(400, "endpoint を入れてください", "endpoint_required");
    const r = await c
      .get("db")
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, user.id)))
      .returning()
      .get();
    if (!r) fail(404, "その通知の登録はありません", "subscription_not_found");
    return c.json({ ok: true });
  });
