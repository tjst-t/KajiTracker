// 通知のテスト用：ブラウザの購読と、プッシュのサービスの代わり
import { expect, vi } from "vitest";

const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
export const enc = new TextEncoder();

/** ブラウザの代わり：購読の鍵を持ち、届いた本文をほどける */
export async function fakeBrowser(endpoint = `https://push.example.com/send/${crypto.randomUUID()}`) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const subscription = { endpoint, keys: { p256dh: b64url(publicKey), auth: b64url(authSecret) } };

  const hkdf = async (salt: Uint8Array, ikm: Uint8Array | ArrayBuffer, info: Uint8Array, bytes: number) => {
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
  };

  /** RFC 8291（aes128gcm）でほどく */
  async function decrypt(body: Uint8Array) {
    const salt = body.slice(0, 16);
    const idLen = body[20]!;
    const serverKey = body.slice(21, 21 + idLen);
    const ciphertext = body.slice(21 + idLen);
    const server = await crypto.subtle.importKey("raw", serverKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
    // Workers の型は $public だが、実際は Web 標準の public で渡す
    const ecdh = { name: "ECDH", public: server } as unknown as SubtleCryptoDeriveKeyAlgorithm;
    const shared = await crypto.subtle.deriveBits(ecdh, pair.privateKey, 256);
    const keyInfo = new Uint8Array([...enc.encode("WebPush: info\0"), ...publicKey, ...serverKey]);
    const ikm = await hkdf(authSecret, shared, keyInfo, 32);
    const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
    const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, ciphertext));
    let end = plain.length - 1;
    while (plain[end] === 0) end--;
    expect(plain[end]).toBe(2); // 最後の区切り
    return JSON.parse(new TextDecoder().decode(plain.slice(0, end)));
  }

  return { subscription, decrypt };
}

/** 外向きの fetch を差し替え、push.example.com への要求を記録する */
export function mockPushService(status: (url: string) => number) {
  const calls: { url: string; headers: Headers; body: Uint8Array }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    calls.push({ url: req.url, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
    return new Response(null, { status: status(req.url) });
  });
  return calls;
}
