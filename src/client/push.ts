// この端末で通知を受ける（Web Push）。Service Worker は public/sw.js
import { ApiError, api } from "./api";

/**
 * この端末の通知の状態
 * - unsupported：このブラウザでは通知を受けられない
 * - needs-home-screen：iPhone・iPad で、ホーム画面に追加していない（追加すると受けられる）
 * - denied：通知が拒否されている（ブラウザの設定から許可する必要がある）
 * - off / on：受けていない / 受けている
 */
export type PushState = "unsupported" | "needs-home-screen" | "denied" | "off" | "on";

/** 画面を開いたときに Service Worker を登録する */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("service worker の登録に失敗しました", e));
  });
}

/** iPhone・iPad（iPadOS の Safari は Mac と名乗るので、タッチの有無で見分ける） */
function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function supported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function getPushState(): Promise<PushState> {
  if (isIos() && !isStandalone()) return "needs-home-screen";
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "off";
  return (await currentSubscription()) ? "on" : "off";
}

function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 通知を受ける：許可を求め、購読を作り、サーバーに送る。結果の状態を返す */
export async function turnOnPush(): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission === "denied") return "denied";
  if (permission !== "granted") return "off";
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const { publicKey } = await api<{ publicKey: string }>("GET", "/push/vapid-public-key");
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) }));
  const json = sub.toJSON();
  try {
    await api("POST", "/push/subscriptions", { endpoint: json.endpoint, keys: json.keys });
  } catch (e) {
    // サーバーに残せなかったら、この端末の購読も戻す（オンに見えて届かない、をなくす）
    await sub.unsubscribe().catch(() => {});
    throw e;
  }
  return "on";
}

/** 通知を受けるのをやめる：この端末の購読を消し、サーバーからも消す */
export async function turnOffPush(): Promise<PushState> {
  const sub = await currentSubscription();
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await api("DELETE", "/push/subscriptions", { endpoint }).catch((e: unknown) => {
      // サーバーに無いのは、もう消えているので気にしない
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    });
  }
  return "off";
}
