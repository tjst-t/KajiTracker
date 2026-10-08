// PWA（マニフェスト・Service Worker・オフラインの殻）を本物のブラウザで確かめる。
// ビルドしたものを配る preview で流す：`npm run preview` を起こしてから `node e2e/pwa-flow.mjs`。
// 別のポートで起こしたときは E2E_ORIGIN=http://localhost:4174 のように渡す。
// 開発サーバ（vite）ではキャッシュを使わない作りなので、ここは preview が相手。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "e2e", "screenshots");
mkdirSync(SHOTS, { recursive: true });
const ORIGIN = process.env.E2E_ORIGIN ?? "http://localhost:4173";

// 通知の許可が要るので、フル版の Chromium を使う（push-flow と同じ）。
// 普通の newContext はシークレット扱いで「インストールできるか」の判定が in-incognito になるので、
// 使い捨てのプロファイルで開く
const profile = mkdtempSync(join(tmpdir(), "kt-pwa-"));
const ctx = await chromium.launchPersistentContext(profile, { channel: "chromium", ...devices["Pixel 7"], locale: "ja-JP" });
const errors = [];
let step = "";
const ok = (s) => console.log(`ok: ${s}`);
const fail = (s) => {
  throw new Error(`[${step}] ${s}`);
};

try {
  await ctx.grantPermissions(["notifications"], { origin: ORIGIN });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${step}] page error: ${e.message}`));
  const cdp = await ctx.newCDPSession(page);

  step = "headers";
  const sw = await ctx.request.get(`${ORIGIN}/sw.js`);
  if (!sw.ok()) fail(`/sw.js が ${sw.status()}`);
  if (!/javascript/.test(sw.headers()["content-type"] ?? "")) fail(`/sw.js の Content-Type: ${sw.headers()["content-type"]}`);
  if (!/no-cache/.test(sw.headers()["cache-control"] ?? "")) fail(`/sw.js の Cache-Control: ${sw.headers()["cache-control"]}`);
  const mf = await ctx.request.get(`${ORIGIN}/manifest.webmanifest`);
  if (!/application\/manifest\+json/.test(mf.headers()["content-type"] ?? "")) fail(`manifest の Content-Type: ${mf.headers()["content-type"]}`);
  const manifest = await mf.json();
  if (manifest.name !== "KajiTracker" || manifest.display !== "standalone" || manifest.start_url !== "/") fail("manifest の中身が違う");
  for (const icon of manifest.icons) {
    const r = await ctx.request.get(`${ORIGIN}${icon.src}`);
    if (!r.ok() || r.headers()["content-type"] !== "image/png") fail(`${icon.src} が配られていない`);
  }
  const apple = await ctx.request.get(`${ORIGIN}/icons/apple-touch-icon.png`);
  if (!apple.ok()) fail("apple-touch-icon が配られていない");
  ok(`sw.js（${sw.headers()["content-type"]}・${sw.headers()["cache-control"]}）と manifest・アイコンが配られる`);

  step = "register";
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  // 最初の読み込みは SW の管理下にない。開き直して管理下にする
  await page.reload();
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  if (!controlled) fail("Service Worker が画面を管理していない");
  ok("Service Worker が登録され、画面を管理している");

  step = "installable";
  const { errors: manifestErrors } = await cdp.send("Page.getAppManifest");
  if (manifestErrors.length) fail(`manifest のエラー: ${JSON.stringify(manifestErrors)}`);
  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
  if (installabilityErrors.length) fail(`インストールできない: ${JSON.stringify(installabilityErrors)}`);
  ok("Chromium の判定でインストールできる（manifest が有効・SW 登録済み）");

  step = "cache";
  // 画面が /api を呼んだあとでも、キャッシュに /api が入っていないこと
  await page.waitForLoadState("networkidle");
  const cached = await page.evaluate(async () => {
    const out = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname);
    }
    return out;
  });
  if (!cached.includes("/")) fail(`殻がキャッシュにない: ${cached}`);
  if (!cached.some((p) => p.startsWith("/assets/"))) fail(`assets がキャッシュにない: ${cached}`);
  if (cached.some((p) => p.startsWith("/api/"))) fail(`/api がキャッシュに入っている: ${cached}`);
  ok(`キャッシュ：${cached.join(" ")}（/api は無い）`);

  step = "offline";
  await ctx.setOffline(true);
  for (const path of ["/", "/settings"]) {
    await page.goto(`${ORIGIN}${path}`);
    await page.waitForFunction(() => document.getElementById("root")?.childElementCount > 0, null, { timeout: 10_000 });
    if ((await page.title()) !== "KajiTracker") fail(`${path} の殻が開かない`);
  }
  await page.screenshot({ path: join(SHOTS, "pwa-offline.png") });
  const api = await page.evaluate(() => fetch("/api/auth/me").then((r) => r.status, (e) => `失敗: ${e.message}`));
  if (typeof api === "number") fail(`オフラインなのに /api が返った（キャッシュされている？）: ${api}`);
  ok("オフラインでも / と /settings の殻が開き、/api は返らない");
  await ctx.setOffline(false);

  step = "push";
  // 通知の処理が壊れていない：SW にプッシュを届け、通知が出ることを見る
  const { targetInfos } = await cdp.send("Target.getTargets");
  const swTarget = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(ORIGIN));
  if (!swTarget) fail("Service Worker のターゲットが見つからない");
  await cdp.send("ServiceWorker.enable");
  const registrationId = await new Promise((resolve) => {
    cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
      const r = registrations.find((x) => x.scopeURL === `${ORIGIN}/` && !x.isDeleted);
      if (r) resolve(r.registrationId);
    });
  });
  await cdp.send("ServiceWorker.deliverPushMessage", {
    origin: ORIGIN,
    registrationId,
    data: JSON.stringify({ title: "PWA の確認", body: "通知の処理が動いている", url: "/" }),
  });
  await page.waitForFunction(
    async () => (await (await navigator.serviceWorker.ready).getNotifications()).some((n) => n.title === "PWA の確認"),
    null,
    { timeout: 10_000, polling: 200 },
  );
  ok("プッシュを届けると通知が出る");

  if (errors.length) fail(errors.join("\n"));
  console.log("PWA の確認がすべて通りました");
} finally {
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
}
