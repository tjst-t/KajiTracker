// 設定の「この端末で通知を受ける」を本物のブラウザで通す。
// 開発サーバを起こしてから `node e2e/push-flow.mjs`（npm run e2e では chores-flow のあとに流れる）。
// 別のポートで起こしたときは E2E_ORIGIN=http://localhost:5174 のように渡す（.dev.vars の ORIGINS にも足す）。
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "e2e", "screenshots");
mkdirSync(SHOTS, { recursive: true });
const ORIGIN = process.env.E2E_ORIGIN ?? "http://localhost:5173";

const newLink = () =>
  execSync(`npm run -s bootstrap-link -- --origin ${ORIGIN}`, { cwd: ROOT })
    .toString()
    .match(/https?:\/\/\S+#login=\S+/)[0];
// 既定の headless shell は通知を許可しても Notification.permission が "denied" のままなので、フル版の Chromium を使う
const browser = await chromium.launch({ channel: "chromium" });
const errors = [];
let step = "";
const ok = (s) => console.log(`ok: ${s}`);

async function device(options) {
  const ctx = await browser.newContext({ deviceScaleFactor: 2, locale: "ja-JP", ...options });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${step}] page error: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("status of 401") && !(step === "off-again" && m.text().includes("status of 404")) && errors.push(`[${step}] console: ${m.text()}`));
  page.on("dialog", (d) => d.accept());
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { page, ctx };
}

/** 最初の1人として入り、Family を作って、設定を開く */
async function signUpAndOpenSettings(page, name) {
  await page.goto(newLink());
  await page.getByLabel("名前").fill(name);
  await page.getByRole("button", { name: "はじめる" }).click();
  await page.getByRole("button", { name: "パスキーを作る" }).click();
  await page.getByLabel("Family の名前").fill(`通知テスト${Date.now() % 10000}`);
  await page.getByRole("button", { name: "Family を作る" }).click();
  await page.getByRole("heading", { name: "まだ家事がありません" }).waitFor();
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("heading", { level: 1, name: "設定" }).waitFor();
}

/**
 * ヘッドレスの Chromium は本物のプッシュサービスにつながらず pushManager.subscribe が失敗するので、
 * subscribe・getSubscription だけを偽の購読（https の endpoint と正しい形の鍵）に差し替える。
 * 画面 → API の流れは本物のまま通る。
 */
function fakePushService() {
  let current = null;
  const b64url = (n) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  PushManager.prototype.getSubscription = async () => current;
  PushManager.prototype.subscribe = async (options) => {
    if (!options?.applicationServerKey || !options.userVisibleOnly) throw new Error("subscribe の引数が足りない");
    const endpoint = `https://push.example.test/send/${b64url(16)}`;
    const keys = { p256dh: b64url(65), auth: b64url(16) };
    current = {
      endpoint,
      expirationTime: null,
      toJSON: () => ({ endpoint, expirationTime: null, keys }),
      unsubscribe: async () => {
        current = null;
        return true;
      },
    };
    return current;
  };
}

/** この端末（ブラウザ）の購読の endpoint */
const subscriptionEndpoint = (page) =>
  page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration("/");
    return (await reg?.pushManager.getSubscription())?.endpoint ?? null;
  });

try {
  // ---- PC（Chromium）：許可を与えてオン・オフ ----
  step = "on";
  const { page, ctx } = await device({ viewport: { width: 1280, height: 900 } });
  await ctx.grantPermissions(["notifications"], { origin: ORIGIN });
  await page.addInitScript(fakePushService);
  await signUpAndOpenSettings(page, "あおい");
  const box = page.getByLabel("この端末で通知を受ける");
  await box.waitFor();
  if (await box.isChecked()) throw new Error("最初からオンになっている");

  const [postRes] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/push/subscriptions") && r.request().method() === "POST", { timeout: 10_000 }),
    box.click(),
  ]);
  if (postRes.status() !== 200) throw new Error(`購読の登録が ${postRes.status()}`);
  const body = postRes.request().postDataJSON();
  if (!body.endpoint?.startsWith("https://") || !body.keys?.p256dh || !body.keys?.auth) throw new Error(`送った購読が変: ${JSON.stringify(body)}`);
  await page.getByText("この端末に、通知の時刻にお知らせが届きます。").waitFor();
  if ((await subscriptionEndpoint(page)) !== body.endpoint) throw new Error("端末の購読と送った購読が違う");
  await page.screenshot({ path: `${SHOTS}/30-push-on.png`, fullPage: true });
  ok("オンにすると、購読が POST /api/push/subscriptions に登録される");

  // ---- Service Worker：push を受けると通知を出す ----
  step = "sw-push";
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cdp = await ctx.newCDPSession(page);
  const registrationId = await new Promise((resolve) => {
    cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
      const r = registrations.find((x) => x.scopeURL === `${ORIGIN}/` && !x.isDeleted);
      if (r) resolve(r.registrationId);
    });
    void cdp.send("ServiceWorker.enable");
  });
  const pushData = { title: "今日の家事", body: "ゴミ出し ほか2件", url: "/#today" };
  let shown = [];
  // 起きたばかりの Service Worker が取りこぼすことがあるので、出るまで数回届ける
  for (let i = 0; i < 5 && shown.length === 0; i++) {
    await cdp.send("ServiceWorker.deliverPushMessage", { origin: ORIGIN, registrationId, data: JSON.stringify(pushData) });
    shown = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      for (let j = 0; j < 20; j++) {
        const list = await reg.getNotifications();
        if (list.length) return list.map((n) => ({ title: n.title, body: n.body, data: n.data }));
        await new Promise((r) => setTimeout(r, 100));
      }
      return [];
    });
  }
  const n = shown[0];
  if (!n || n.title !== pushData.title || n.body !== pushData.body || n.data?.url !== pushData.url) throw new Error(`通知が変: ${JSON.stringify(shown)}`);
  ok("Service Worker が push を受けて、題・本文・url の付いた通知を出す");

  step = "off";
  const [delRes] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/push/subscriptions") && r.request().method() === "DELETE", { timeout: 10_000 }),
    page.getByLabel("この端末で通知を受ける").click(),
  ]);
  if (delRes.status() !== 200) throw new Error(`購読の削除が ${delRes.status()}`);
  if (delRes.request().postDataJSON().endpoint !== body.endpoint) throw new Error("消した購読が違う");
  if ((await subscriptionEndpoint(page)) !== null) throw new Error("端末の購読が残っている");
  // もう一度消すと 404（サーバーからも消えている）。この 404 はコンソールのエラーとして数えない
  step = "off-again";
  const again = await page.evaluate(
    (endpoint) =>
      fetch("/api/push/subscriptions", {
        method: "DELETE",
        headers: { "X-Kaji-Client": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      }).then((r) => r.status),
    body.endpoint,
  );
  if (again !== 404) throw new Error(`サーバーに購読が残っている（${again}）`);
  ok("オフにすると、端末の購読が消え、DELETE /api/push/subscriptions でサーバーからも消える");
  await ctx.close();

  // ---- 通知が拒否されているとき ----
  step = "denied";
  const { page: dPage, ctx: dCtx } = await device({ viewport: { width: 1280, height: 900 } });
  // ブラウザで「ブロック」にしたのと同じに見せる
  await dPage.addInitScript(() => Object.defineProperty(Notification, "permission", { get: () => "denied" }));
  await signUpAndOpenSettings(dPage, "そら");
  await dPage.getByText("通知が拒否されています。").waitFor();
  if (!(await dPage.getByLabel("この端末で通知を受ける").isDisabled())) throw new Error("拒否されているのに押せる");
  await dPage.screenshot({ path: `${SHOTS}/31-push-denied.png`, fullPage: true });
  ok("拒否されているときは、ブラウザの設定から許可する案内");
  await dCtx.close();

  // ---- iPhone の Safari（ホーム画面に追加していない） ----
  step = "ios";
  const { defaultBrowserType: _, ...iPhone } = devices["iPhone 15"];
  const { page: iPage, ctx: iCtx } = await device(iPhone);
  await signUpAndOpenSettings(iPage, "はる");
  await iPage.getByText("ホーム画面に追加すると通知を受けられます。共有ボタン → ホーム画面に追加").waitFor();
  if (await iPage.getByLabel("この端末で通知を受ける").count()) throw new Error("iPhone で通知のオン・オフが出ている");
  await iPage.screenshot({ path: `${SHOTS}/32-push-ios.png`, fullPage: true });
  ok("iPhone でホーム画面に追加していないときは、ホーム画面に追加の案内");
  await iCtx.close();
} catch (e) {
  console.log(`止まった場所: ${step}`);
  for (const p of browser.contexts().flatMap((c) => c.pages())) {
    await p.screenshot({ path: `${SHOTS}/39-push-failed.png`, fullPage: true }).catch(() => {});
    console.log(await p.locator(".error, .notice").allInnerTexts().catch(() => []));
  }
  errors.push(String(e).split("\n").slice(0, 8).join("\n"));
}

await browser.close();
if (errors.length) {
  console.log("エラー:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("ALL OK");
