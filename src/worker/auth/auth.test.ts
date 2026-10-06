import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SoftAuthenticator } from "../../../test/soft-authenticator";
import { TestDevice, ageSessions, bootstrapUser, insertBootstrapTicket } from "../../../test/client";

const MIN = 60_000;

describe("入口の守り", () => {
  it("X-Kaji-Client ヘッダが無ければ断る", async () => {
    const d = new TestDevice();
    const r = await d.req("POST", "/api/auth/login/options", {}, { "X-Kaji-Client": "" });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("missing_client_header");
  });

  it("よその Origin からは断る", async () => {
    const d = new TestDevice();
    const r = await d.req("POST", "/api/auth/login/options", {}, { Origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("bad_origin");
  });

  it("ログインしていなければ /api/me は 401", async () => {
    expect((await new TestDevice().get("/api/me")).status).toBe(401);
  });
});

describe("最初の1人（bootstrap の札）", () => {
  it("名前を入れて札を引き換えると、ユーザーができてログインした状態になる", async () => {
    const d = new TestDevice();
    const token = await insertBootstrapTicket();
    expect((await d.post("/api/auth/ticket-info", { token })).json).toEqual({ valid: true, kind: "bootstrap" });

    const noName = await d.redeem(token);
    expect(noName.status).toBe(400);
    expect(noName.json.code).toBe("display_name_required");

    expect((await d.redeem(token, "たくみ")).status).toBe(200);
    const me = await d.get("/api/me");
    expect(me.json).toMatchObject({ user: { displayName: "たくみ", notifyTime: "20:00" }, session: { via: "bootstrap", stepUpOk: true }, passkeyCount: 0 });
  });

  it("札は1回しか使えない", async () => {
    const token = await insertBootstrapTicket();
    expect((await new TestDevice().redeem(token, "A")).status).toBe(200);
    const again = await new TestDevice().redeem(token, "B");
    expect(again.status).toBe(400);
    expect(again.json.code).toBe("ticket_invalid");
    expect((await new TestDevice().post("/api/auth/ticket-info", { token })).json).toEqual({ valid: false });
  });

  it("期限の切れた札は使えない", async () => {
    const token = await insertBootstrapTicket(-1000);
    expect((await new TestDevice().redeem(token, "A")).status).toBe(400);
  });

  it("札で入った直後はパスキーを登録でき、続けてそのパスキーでログインできる", async () => {
    const d = new TestDevice();
    await d.redeem(await insertBootstrapTicket(), "たくみ");
    const reg = await d.registerPasskey();
    expect(reg.status).toBe(200);
    expect(reg.json.name).toBe("iPhone の Safari"); // 名前を付けなければ User-Agent から

    await d.post("/api/auth/logout");
    expect((await d.get("/api/me")).status).toBe(401);

    expect((await d.loginWithPasskey()).status).toBe(200);
    expect((await d.get("/api/me")).json).toMatchObject({ user: { displayName: "たくみ" }, session: { via: "passkey" }, passkeyCount: 1 });
  });
});

describe("パスキー", () => {
  it("登録されていないパスキーではログインできない", async () => {
    const d = new TestDevice();
    const stranger = new SoftAuthenticator();
    await stranger.register({ challenge: "x", rp: { id: "localhost", name: "x" }, user: { id: "dQ", name: "x", displayName: "x" }, pubKeyCredParams: [] }, "http://localhost:5173");
    const r = await d.loginWithPasskey(stranger);
    expect(r.status).toBe(401);
    expect(r.json.code).toBe("unknown_passkey");
  });

  it("challenge は1回だけ：同じ応答をもう一度送っても通らない", async () => {
    const d = await bootstrapUser();
    await d.post("/api/auth/logout");
    const opts = await d.post("/api/auth/login/options");
    const response = await d.authenticator.authenticate(opts.json, "http://localhost:5173");
    expect((await d.post("/api/auth/login/verify", { response })).status).toBe(200);
    expect((await d.post("/api/auth/login/verify", { response })).status).toBe(400);
  });

  it("別のオリジン向けに作られた応答は通らない", async () => {
    const d = await bootstrapUser();
    await d.post("/api/auth/logout");
    const opts = await d.post("/api/auth/login/options");
    const response = await d.authenticator.authenticate(opts.json, "https://evil.example");
    expect((await d.post("/api/auth/login/verify", { response })).status).toBe(401);
  });

  it("同じパスキーは二重に登録できない（excludeCredentials に入る）", async () => {
    const d = await bootstrapUser();
    const opts = await d.post("/api/auth/register/options");
    expect(opts.json.excludeCredentials).toHaveLength(1);
    expect(opts.json.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
  });

  it("パスキーの削除には step-up が要る", async () => {
    const d = await bootstrapUser();
    const [pk] = (await d.get("/api/me/passkeys")).json;
    await ageSessions(d, "created_at", 11 * MIN);
    const r = await d.del(`/api/me/passkeys/${pk.id}`);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("step_up_required");
    expect((await d.stepUp()).status).toBe(200);
    expect((await d.del(`/api/me/passkeys/${pk.id}`)).status).toBe(200);
    expect((await d.get("/api/me/passkeys")).json).toHaveLength(0);
  });
});

describe("step-up（大事な操作の前の確認）", () => {
  it("パスキーで入ってから5分は済んだもの、過ぎたら求める", async () => {
    const d = await bootstrapUser();
    await d.post("/api/auth/logout");
    await d.loginWithPasskey();
    expect((await d.post("/api/me/device-tickets")).status).toBe(200);

    await ageSessions(d, "step_up_at", 6 * MIN);
    expect((await d.get("/api/me")).json.session.stepUpOk).toBe(false);
    expect((await d.post("/api/me/device-tickets")).status).toBe(403);

    expect((await d.stepUp()).status).toBe(200);
    expect((await d.post("/api/me/device-tickets")).status).toBe(200);
  });

  it("札で入ってから10分を過ぎ、パスキーがあれば求める", async () => {
    const d = await bootstrapUser();
    await ageSessions(d, "created_at", 11 * MIN);
    expect((await d.post("/api/auth/register/options")).status).toBe(403);
  });

  it("ほかの人のパスキーでは step-up できない", async () => {
    const a = await bootstrapUser("A");
    const b = await bootstrapUser("B");
    await ageSessions(a, "created_at", 11 * MIN);
    const opts = await a.post("/api/auth/step-up/options");
    const response = await b.authenticator.authenticate(opts.json, "http://localhost:5173", "localhost");
    expect((await a.post("/api/auth/step-up/verify", { response })).status).toBe(401);
  });
});

describe("端末を追加", () => {
  it("札（QR とリンク）で新しい端末が入り、出した側は使われたことを知る", async () => {
    const phone = await bootstrapUser();
    const t = await phone.post("/api/me/device-tickets");
    expect(t.status).toBe(200);
    expect(t.json.url).toMatch(/^http:\/\/localhost:5173\/#login=/);
    expect((await phone.get(`/api/me/device-tickets/${t.json.id}`)).json).toEqual({ used: false, deviceLabel: null, expired: false });

    const pc = new TestDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36");
    const token = t.json.url.split("#login=")[1];
    expect((await pc.post("/api/auth/ticket-info", { token })).json).toEqual({ valid: true, kind: "device" });
    expect((await pc.redeem(token)).status).toBe(200);
    expect((await pc.get("/api/me")).json).toMatchObject({ user: { displayName: "たくみ" }, session: { via: "device_ticket", stepUpOk: true } });

    expect((await phone.get(`/api/me/device-tickets/${t.json.id}`)).json).toEqual({ used: true, deviceLabel: "Windows の Chrome", expired: false });

    // 入った直後は、すでにパスキーがあっても自分のパスキーを登録できる（banto で分かった落とし穴）
    const reg = await pc.registerPasskey();
    expect(reg.status).toBe(200);
    expect(reg.json.name).toBe("Windows の Chrome");
    expect((await pc.get("/api/me/passkeys")).json).toHaveLength(2);
  });

  it("ほかの人の札の状態は見られない", async () => {
    const a = await bootstrapUser("A");
    const b = await bootstrapUser("B");
    const t = await a.post("/api/me/device-tickets");
    expect((await b.get(`/api/me/device-tickets/${t.json.id}`)).status).toBe(404);
  });
});

describe("ログイン中の端末", () => {
  it("一覧に出て、ほかの端末を締め出せる（step-up つき）", async () => {
    const phone = await bootstrapUser();
    const t = await phone.post("/api/me/device-tickets");
    const pc = new TestDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15");
    await pc.redeem(t.json.url.split("#login=")[1]);

    const list = (await phone.get("/api/me/sessions")).json;
    expect(list).toHaveLength(2);
    const other = list.find((s: any) => !s.current);
    expect(other).toMatchObject({ deviceLabel: "Mac の Safari", via: "device_ticket" });

    await ageSessions(phone, "created_at", 11 * MIN);
    expect((await phone.del(`/api/me/sessions/${other.id}`)).status).toBe(403);
    await phone.stepUp();
    expect((await phone.del(`/api/me/sessions/${other.id}`)).status).toBe(200);
    expect((await pc.get("/api/me")).status).toBe(401);
  });

  it("自分の端末を消すのはログアウトと同じで、step-up は要らない", async () => {
    const d = await bootstrapUser();
    await ageSessions(d, "created_at", 11 * MIN);
    const me = (await d.get("/api/me")).json;
    expect((await d.del(`/api/me/sessions/${me.session.id}`)).status).toBe(200);
    expect((await d.get("/api/me")).status).toBe(401);
  });

  it("最後に使ってから30日で切れる", async () => {
    const d = await bootstrapUser();
    await ageSessions(d, "last_used_at", 29 * 24 * 60 * MIN);
    expect((await d.get("/api/me")).status).toBe(200); // 使ったので延びる
    await ageSessions(d, "last_used_at", 31 * 24 * 60 * MIN);
    expect((await d.get("/api/me")).status).toBe(401);
    const left = await env.DB.prepare("SELECT count(*) AS n FROM sessions WHERE user_id = ?").bind(d.userId).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe("自分の設定", () => {
  it("名前と通知の時刻を変えられる。時刻は15分きざみ", async () => {
    const d = await bootstrapUser();
    expect((await d.patch("/api/me", { displayName: "たくみ（父）", notifyTime: "07:15" })).json.user).toMatchObject({
      displayName: "たくみ（父）",
      notifyTime: "07:15",
    });
    expect((await d.patch("/api/me", { notifyTime: "07:10" })).status).toBe(400);
    expect((await d.patch("/api/me", { notifyTime: "24:00" })).status).toBe(400);
    expect((await d.patch("/api/me", { displayName: "" })).status).toBe(400);
  });
});

describe("回数制限", () => {
  it("札の引き換えは1分に10回まで", async () => {
    const d = new TestDevice();
    for (let i = 0; i < 10; i++) expect((await d.redeem(`wrong-${i}`)).status).toBe(400);
    const r = await d.redeem("wrong-x");
    expect(r.status).toBe(429);
  });
});
