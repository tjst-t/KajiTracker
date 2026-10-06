// テスト用の「端末」。Cookie を覚えて Worker に要求を送る
import { exports } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { SoftAuthenticator } from "./soft-authenticator";

export const ORIGIN = "http://localhost:5173";

export class TestDevice {
  private jar = new Map<string, string>();
  authenticator = new SoftAuthenticator();
  /** 端末ごとに別の IP にする（回数制限がテストどうしで混ざらないように） */
  ip = `10.0.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

  constructor(private userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1") {}

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const h: Record<string, string> = {
      "X-Kaji-Client": "1",
      Origin: ORIGIN,
      "User-Agent": this.userAgent,
      "CF-Connecting-IP": this.ip,
      ...headers,
    };
    if (body !== undefined) h["Content-Type"] = "application/json";
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) h.Cookie = cookie;
    const res = await exports.default.fetch(`${ORIGIN}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const [k, v] = pair!.split("=") as [string, string];
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim()));
      if (expired || v === "") this.jar.delete(k.trim());
      else this.jar.set(k.trim(), v);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json };
  }

  get = (p: string) => this.req("GET", p);
  post = (p: string, b: unknown = {}) => this.req("POST", p, b);
  patch = (p: string, b: unknown) => this.req("PATCH", p, b);
  del = (p: string) => this.req("DELETE", p);

  /** ログインしているユーザーの id（redeem・loginWithPasskey のあとに入る） */
  userId = "";

  private async rememberUser() {
    const me = await this.get("/api/me");
    if (me.status === 200) this.userId = me.json.user.id;
  }

  async redeem(token: string, displayName?: string) {
    const r = await this.post("/api/auth/redeem", { token, displayName });
    if (r.status === 200) await this.rememberUser();
    return r;
  }

  async registerPasskey(name?: string) {
    const opts = await this.post("/api/auth/register/options");
    if (opts.status !== 200) return opts;
    const response = await this.authenticator.register(opts.json, ORIGIN);
    return this.post("/api/auth/register/verify", { response, name });
  }

  async loginWithPasskey(auth = this.authenticator) {
    const opts = await this.post("/api/auth/login/options");
    const response = await auth.authenticate(opts.json, ORIGIN);
    const r = await this.post("/api/auth/login/verify", { response });
    if (r.status === 200) await this.rememberUser();
    return r;
  }

  async stepUp() {
    const opts = await this.post("/api/auth/step-up/options");
    const response = await this.authenticator.authenticate(opts.json, ORIGIN);
    return this.post("/api/auth/step-up/verify", { response });
  }
}

async function sha256Hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** scripts/bootstrap-link.mjs と同じことを D1 に直接する */
export async function insertBootstrapTicket(expiresInMs = 10 * 60_000): Promise<string> {
  const token = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.prepare("INSERT INTO login_tickets (id, kind, expires_at) VALUES (?, 'bootstrap', ?)")
    .bind(await sha256Hex(token), new Date(Date.now() + expiresInMs).toISOString())
    .run();
  return token;
}

/** 最初の1人を作ってパスキーを登録した端末を返す */
export async function bootstrapUser(name = "たくみ") {
  const d = new TestDevice();
  await d.redeem(await insertBootstrapTicket(), name);
  await d.registerPasskey("テストの iPhone");
  return d;
}

/** セッションの時刻を過去にずらす（step-up の期限や30日の期限を試す） */
export async function ageSessions(device: TestDevice, column: "step_up_at" | "created_at" | "last_used_at", msAgo: number) {
  await env.DB.prepare(`UPDATE sessions SET ${column} = ? WHERE user_id = ?`)
    .bind(new Date(Date.now() - msAgo).toISOString(), device.userId)
    .run();
}
