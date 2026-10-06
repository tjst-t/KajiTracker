// 札・セッション・ID に使う乱数とハッシュ
export const bytesToBase64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** 推測できない値（256 bit） */
export function randomToken(bytes = 32): string {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** 行の ID（時刻順に並ぶ必要は無い） */
export function newId(): string {
  return randomToken(16);
}

/** サーバに置くのは札やセッションの値そのものではなく、このハッシュ */
export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
