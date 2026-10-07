import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestDevice, bootstrapUser } from "../../../test/client";
import { enc, fakeBrowser, fromB64url, mockPushService } from "../../../test/push";
import { sendPushToUser } from "./send";

const subsOf = (userId: string) =>
  env.DB.prepare("SELECT endpoint, p256dh, auth, device_label, last_success_at FROM push_subscriptions WHERE user_id = ? ORDER BY created_at")
    .bind(userId)
    .all<{ endpoint: string; p256dh: string; auth: string; device_label: string; last_success_at: string | null }>()
    .then((r) => r.results);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("通知の購読", () => {
  it("ログインしていなければ使えない", async () => {
    const d = new TestDevice();
    expect((await d.get("/api/push/vapid-public-key")).status).toBe(401);
    expect((await d.post("/api/push/subscriptions", {})).status).toBe(401);
    expect((await d.req("DELETE", "/api/push/subscriptions", { endpoint: "https://push.example.com/x" })).status).toBe(401);
  });

  it("公開鍵を返す", async () => {
    const d = await bootstrapUser();
    expect((await d.get("/api/push/vapid-public-key")).json).toEqual({ publicKey: env.VAPID_PUBLIC_KEY });
  });

  it("登録すると端末名つきで入り、同じ endpoint は上書きする", async () => {
    const d = await bootstrapUser();
    const { subscription } = await fakeBrowser();
    expect((await d.post("/api/push/subscriptions", subscription)).status).toBe(200);
    expect(await subsOf(d.userId)).toEqual([
      { endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth, device_label: "iPhone の Safari", last_success_at: null },
    ]);

    const next = { endpoint: subscription.endpoint, keys: { p256dh: "BBBB", auth: "cccc" } };
    expect((await d.post("/api/push/subscriptions", next)).status).toBe(200);
    expect(await subsOf(d.userId)).toMatchObject([{ endpoint: subscription.endpoint, p256dh: "BBBB", auth: "cccc" }]);
  });

  it("同じ endpoint を別の人が登録したら、その人のものになる", async () => {
    const a = await bootstrapUser("A");
    const b = await bootstrapUser("B");
    const { subscription } = await fakeBrowser();
    await a.post("/api/push/subscriptions", subscription);
    await b.post("/api/push/subscriptions", subscription);
    expect(await subsOf(a.userId)).toEqual([]);
    expect(await subsOf(b.userId)).toHaveLength(1);
  });

  it("足りない・おかしい値は断る", async () => {
    const d = await bootstrapUser();
    const { subscription } = await fakeBrowser();
    const bad = [
      {},
      { ...subscription, endpoint: "http://push.example.com/x" },
      { ...subscription, endpoint: "ふつうの文字" },
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh } },
      { endpoint: subscription.endpoint, keys: { p256dh: "a b", auth: "x" } },
    ];
    for (const b of bad) expect((await d.post("/api/push/subscriptions", b)).status).toBe(400);
    expect(await subsOf(d.userId)).toEqual([]);
  });

  it("消せるのは自分の購読だけ", async () => {
    const a = await bootstrapUser("A");
    const b = await bootstrapUser("B");
    const { subscription } = await fakeBrowser();
    await a.post("/api/push/subscriptions", subscription);

    const r = await b.req("DELETE", "/api/push/subscriptions", { endpoint: subscription.endpoint });
    expect(r.status).toBe(404);
    expect(await subsOf(a.userId)).toHaveLength(1);

    expect((await a.req("DELETE", "/api/push/subscriptions", { endpoint: subscription.endpoint })).status).toBe(200);
    expect(await subsOf(a.userId)).toEqual([]);
    expect((await a.req("DELETE", "/api/push/subscriptions", {})).status).toBe(400);
  });
});

describe("通知を送る", () => {
  it("全部の購読に、暗号化した本文と VAPID の署名をつけて送り、届いたら last_success_at を入れる", async () => {
    const d = await bootstrapUser();
    const phone = await fakeBrowser();
    const pc = await fakeBrowser();
    await d.post("/api/push/subscriptions", phone.subscription);
    await d.post("/api/push/subscriptions", pc.subscription);
    const other = await bootstrapUser("ほかの人");
    await other.post("/api/push/subscriptions", (await fakeBrowser()).subscription);

    const calls = mockPushService(() => 201);
    const payload = { title: "今日の家事", body: "ゴミ出し・洗濯槽の掃除", url: "/" };
    expect(await sendPushToUser(env, d.userId, payload)).toEqual({ sent: 2, failed: 0, removed: 0 });

    expect(calls.map((c) => c.url).sort()).toEqual([phone.subscription.endpoint, pc.subscription.endpoint].sort());
    for (const browser of [phone, pc]) {
      const call = calls.find((c) => c.url === browser.subscription.endpoint)!;
      expect(call.headers.get("Content-Encoding")).toBe("aes128gcm");
      expect(call.headers.get("TTL")).toBeTruthy();
      // 本文はそのままでは読めず、購読の鍵でほどくと元に戻る
      expect(new TextDecoder().decode(call.body)).not.toContain("ゴミ出し");
      expect(await browser.decrypt(call.body)).toEqual(payload);

      // Authorization: vapid t=<JWT>, k=<公開鍵>。JWT はサーバの鍵で署名されている
      const m = /^vapid t=([^,]+), k=(.+)$/.exec(call.headers.get("Authorization") ?? "");
      expect(m).not.toBeNull();
      const [, jwt, k] = m!;
      expect(k).toBe(env.VAPID_PUBLIC_KEY);
      const [h, p, sig] = jwt!.split(".") as [string, string, string];
      const claims = JSON.parse(new TextDecoder().decode(fromB64url(p)));
      expect(claims).toMatchObject({ aud: "https://push.example.com", sub: env.VAPID_SUBJECT });
      const key = await crypto.subtle.importKey("raw", fromB64url(k!), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64url(sig), enc.encode(`${h}.${p}`))).toBe(true);
    }

    const subs = await subsOf(d.userId);
    expect(subs.every((s) => s.last_success_at !== null)).toBe(true);
    expect(await subsOf(other.userId)).toMatchObject([{ last_success_at: null }]);
  });

  it("404・410 が返った購読は消し、ほかのエラーなら残す", async () => {
    const d = await bootstrapUser();
    const gone = await fakeBrowser("https://push.example.com/gone");
    const missing = await fakeBrowser("https://push.example.com/missing");
    const busy = await fakeBrowser("https://push.example.com/busy");
    const ok = await fakeBrowser("https://push.example.com/ok");
    for (const b of [gone, missing, busy, ok]) await d.post("/api/push/subscriptions", b.subscription);

    mockPushService((url) => ({ gone: 410, missing: 404, busy: 503 })[url.split("/").pop() as "gone"] ?? 201);
    expect(await sendPushToUser(env, d.userId, { title: "今日の家事", body: "ゴミ出し" })).toEqual({ sent: 1, failed: 1, removed: 2 });
    expect((await subsOf(d.userId)).map((s) => s.endpoint).sort()).toEqual([busy.subscription.endpoint, ok.subscription.endpoint].sort());
  });

  it("購読が無ければ何も送らない", async () => {
    const d = await bootstrapUser();
    const calls = mockPushService(() => 201);
    expect(await sendPushToUser(env, d.userId, { title: "今日の家事", body: "ゴミ出し" })).toEqual({ sent: 0, failed: 0, removed: 0 });
    expect(calls).toEqual([]);
  });
});
