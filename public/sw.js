// KajiTracker の Service Worker。通知（Web Push）を受けて出すのと、画面の殻のキャッシュ。
// 手で書いている（vite-plugin-pwa は使わない）。
//
// キャッシュの決まり：
// - 画面の移動（navigate）：ネット優先。落ちたらキャッシュした殻（ビルドされた index.html）を返す
// - /assets/*（ファイル名にハッシュが付く）：キャッシュ優先
// - /api/*：キャッシュしない（ログインや家事のデータを古いまま見せない）
// - CACHE_VERSION を上げると、activate で古いキャッシュを消す
// 開発サーバ（vite）では src/client/push.ts が "/sw.js?dev" で登録する。そのときはキャッシュを使わない。

const CACHE_VERSION = "v1";
const CACHE_PREFIX = "kajitracker-";
const SHELL_CACHE = `${CACHE_PREFIX}shell-${CACHE_VERSION}`;
const ASSET_CACHE = `${CACHE_PREFIX}assets-${CACHE_VERSION}`;
const SHELL_URL = "/";
const STATIC_URLS = ["/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png", "/icons/apple-touch-icon.png"];
const DEV = new URL(self.location.href).searchParams.has("dev");

/** 殻（index.html）が読む /assets/* を拾う */
function assetUrlsIn(html) {
  return [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]))];
}

/** 殻と、殻が読む assets をキャッシュに入れる */
async function cacheShell() {
  const res = await fetch(SHELL_URL, { cache: "reload" });
  if (!res.ok) throw new Error(`殻を取れませんでした: ${res.status}`);
  const html = await res.clone().text();
  const shell = await caches.open(SHELL_CACHE);
  await shell.put(SHELL_URL, res);
  await shell.addAll(STATIC_URLS).catch(() => {});
  const assets = await caches.open(ASSET_CACHE);
  await assets.addAll(assetUrlsIn(html));
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  if (DEV) return;
  event.waitUntil(cacheShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = DEV ? [] : [SHELL_CACHE, ASSET_CACHE];
      for (const key of await caches.keys()) {
        if (key.startsWith(CACHE_PREFIX) && !keep.includes(key)) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

/**
 * 新しい殻を入れ、それが読まない古い /assets/* を捨てる（デプロイのたびに溜まらないように）。
 * 殻が変わらないとき（同じデプロイ）は捨てない。殻から直接は読まれない分割チャンクも残すため
 */
async function refreshShell(res) {
  const html = await res.clone().text();
  const shell = await caches.open(SHELL_CACHE);
  const before = await shell.match(SHELL_URL);
  await shell.put(SHELL_URL, res);
  if (!before || (await before.text()) === html) return;
  const used = new Set(assetUrlsIn(html));
  const assets = await caches.open(ASSET_CACHE);
  for (const req of await assets.keys()) {
    if (!used.has(new URL(req.url).pathname)) await assets.delete(req);
  }
}

/** ネット優先。取れたら殻を新しくし、落ちたらキャッシュした殻を返す */
async function navigate(request) {
  try {
    const res = await fetch(request);
    if (res.ok && (res.headers.get("content-type") || "").includes("text/html")) {
      const copy = res.clone();
      refreshShell(copy).catch(() => {});
    }
    return res;
  } catch (e) {
    const cached = await caches.match(SHELL_URL, { cacheName: SHELL_CACHE });
    if (cached) return cached;
    throw e;
  }
}

/** キャッシュ優先。無ければ取ってきて入れる */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request, { cacheName });
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) {
    const copy = res.clone();
    caches.open(cacheName).then((c) => c.put(request, copy)).catch(() => {});
  }
  return res;
}

/** ネット優先。落ちたらキャッシュ（manifest・アイコン） */
async function networkFirst(request, cacheName) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const copy = res.clone();
      caches.open(cacheName).then((c) => c.put(request, copy)).catch(() => {});
    }
    return res;
  } catch (e) {
    const cached = await caches.match(request, { cacheName });
    if (cached) return cached;
    throw e;
  }
}

self.addEventListener("fetch", (event) => {
  if (DEV) return;
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(navigate(request));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
  } else if (STATIC_URLS.includes(url.pathname)) {
    event.respondWith(networkFirst(request, SHELL_CACHE));
  }
});

// サーバーからの通知：{ title, body, url? }（src/worker/push/send.ts の PushPayload）
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "KajiTracker";
  const url = payload.url || payload.data?.url || "/";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      icon: payload.icon,
      tag: payload.tag,
      data: { url },
    }),
  );
});

// 通知を押したら、開いている画面があればそこへ、なければ新しく開く
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const same = windows.find((w) => w.url === url) || windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (same) {
        await same.focus();
        if (same.url !== url && "navigate" in same) await same.navigate(url).catch(() => {});
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
