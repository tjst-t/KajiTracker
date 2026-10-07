// Web Push を送る。暗号化（aes128gcm）と VAPID の署名は @block65/webcrypto-web-push（Web Crypto で動く）
import { buildPushPayload } from "@block65/webcrypto-web-push";
import { eq } from "drizzle-orm";
import { nowIso } from "../context";
import { getDb } from "../db";
import { pushSubscriptions } from "../db/schema";

/** 通知の中身。Service Worker が受け取って出す */
export type PushPayload = { title: string; body: string; url?: string };

export type SendResult = { sent: number; failed: number; removed: number };

/** その人の全部の購読に送る。404・410 が返った購読（もう使えない）は消す */
export async function sendPushToUser(env: Env, userId: string, payload: PushPayload): Promise<SendResult> {
  const db = getDb(env.DB);
  const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).all();
  const vapid = { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const result: SendResult = { sent: 0, failed: 0, removed: 0 };
  await Promise.all(
    subs.map(async (s) => {
      try {
        const req = await buildPushPayload(
          { data: payload, options: { ttl: 60 * 60, urgency: "normal" } },
          { endpoint: s.endpoint, expirationTime: null, keys: { p256dh: s.p256dh, auth: s.auth } },
          vapid,
        );
        const res = await fetch(s.endpoint, req);
        if (res.ok) {
          await db.update(pushSubscriptions).set({ lastSuccessAt: nowIso() }).where(eq(pushSubscriptions.id, s.id));
          result.sent++;
        } else if (res.status === 404 || res.status === 410) {
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
          result.removed++;
        } else {
          console.warn(`push failed: ${res.status} ${s.id}`);
          result.failed++;
        }
      } catch (e) {
        console.warn(`push failed: ${s.id}`, e);
        result.failed++;
      }
    }),
  );
  return result;
}
