// KajiTracker の Service Worker。通知（Web Push）を受けて出す。
// 手で書いている（vite-plugin-pwa は使わない）。オフラインのためのキャッシュは後でここに足す。

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
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
