import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { TestDevice, ageSessions, bootstrapUser } from "../../../test/client";

const MIN = 60_000;
const tokenOf = (url: string, key: "invite" | "login") => url.split(`#${key}=`)[1]!;

/** たくみ（管理者）が Family を作り、妻を招待で入れた状態 */
async function familyWithWife() {
  const takumi = await bootstrapUser("たくみ");
  const fam = (await takumi.post("/api/families", { name: "辻下家" })).json;
  const inv = (await takumi.post(`/api/families/${fam.id}/invites`)).json;
  const wife = new TestDevice();
  await wife.registerViaInvite(tokenOf(inv.url, "invite"), "妻");
  return { takumi, wife, fam };
}

async function insertChore(familyId: string, assignee: string | null) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO chores (id, family_id, name, schedule_type, interval_days, first_due_on, assignee_user_id) VALUES (?, ?, 'ゴミ出し', 'interval', 7, '2026-10-10', ?)",
  )
    .bind(id, familyId, assignee)
    .run();
  return id;
}

describe("Family を作る", () => {
  it("作った人が管理者になり、一覧に出る", async () => {
    const d = await bootstrapUser();
    expect((await d.get("/api/families")).json).toEqual([]);
    const r = await d.post("/api/families", { name: "辻下家" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: "辻下家", role: "admin" });
    expect((await d.get("/api/families")).json).toEqual([{ id: r.json.id, name: "辻下家", role: "admin" }]);
  });

  it("名前が空・長すぎるなら断る", async () => {
    const d = await bootstrapUser();
    expect((await d.post("/api/families", { name: " " })).status).toBe(400);
    expect((await d.post("/api/families", { name: "あ".repeat(31) })).status).toBe(400);
  });

  it("1人が複数の Family に入れる", async () => {
    const d = await bootstrapUser();
    await d.post("/api/families", { name: "辻下家" });
    await d.post("/api/families", { name: "実家" });
    expect((await d.get("/api/families")).json.map((f: any) => f.name)).toEqual(["辻下家", "実家"]);
  });

  it("よその Family は見えない（404）", async () => {
    const a = await bootstrapUser("A");
    const b = await bootstrapUser("B");
    const fam = (await a.post("/api/families", { name: "A家" })).json;
    expect((await b.get(`/api/families/${fam.id}/members`)).status).toBe(404);
    expect((await b.post(`/api/families/${fam.id}/invites`)).status).toBe(404);
  });
});

describe("招待（QR）", () => {
  it("初めての人：招待を開き、名前を入れてパスキーを作ると、メンバーとして入ってログインした状態になる", async () => {
    const takumi = await bootstrapUser("たくみ");
    const fam = (await takumi.post("/api/families", { name: "辻下家" })).json;
    const inv = await takumi.post(`/api/families/${fam.id}/invites`);
    expect(inv.status).toBe(201);
    expect(inv.json.url).toMatch(/^http:\/\/localhost:5173\/#invite=/);
    const token = tokenOf(inv.json.url, "invite");

    const wife = new TestDevice();
    expect((await wife.post("/api/invites/info", { token })).json).toEqual({
      valid: true,
      familyId: fam.id,
      familyName: "辻下家",
      invitedBy: "たくみ",
      alreadyMember: false,
    });
    const r = await wife.registerViaInvite(token, "妻");
    expect(r.status).toBe(200);

    const me = (await wife.get("/api/me")).json;
    expect(me).toMatchObject({ user: { displayName: "妻" }, session: { via: "passkey" }, passkeyCount: 1 });
    expect((await wife.get("/api/families")).json).toEqual([{ id: fam.id, name: "辻下家", role: "member" }]);
    expect((await takumi.get(`/api/families/${fam.id}/invites/${inv.json.id}`)).json).toEqual({ used: true, usedByName: "妻", expired: false });

    // 作ったパスキーで、あとからログインできる
    await wife.post("/api/auth/logout");
    expect((await wife.loginWithPasskey()).status).toBe(200);
  });

  it("招待は1回だけ。2人目は使えず、ユーザーも作られない", async () => {
    const takumi = await bootstrapUser("たくみ");
    const fam = (await takumi.post("/api/families", { name: "辻下家" })).json;
    const token = tokenOf((await takumi.post(`/api/families/${fam.id}/invites`)).json.url, "invite");
    expect((await new TestDevice().registerViaInvite(token, "妻")).status).toBe(200);

    const before = await env.DB.prepare("SELECT count(*) AS n FROM users").first<{ n: number }>();
    const second = await new TestDevice().registerViaInvite(token, "だれか");
    expect(second.status).toBe(400);
    expect(second.json.code).toBe("invite_invalid");
    const after = await env.DB.prepare("SELECT count(*) AS n FROM users").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it("同じ招待で2人が同時にパスキーを作り終えても、入れるのは先の1人だけ（後の人のユーザーは消える）", async () => {
    const takumi = await bootstrapUser("たくみ");
    const fam = (await takumi.post("/api/families", { name: "辻下家" })).json;
    const token = tokenOf((await takumi.post(`/api/families/${fam.id}/invites`)).json.url, "invite");
    const a = new TestDevice();
    const b = new TestDevice();
    const oa = await a.post("/api/invites/register/options", { token, displayName: "A" });
    const ob = await b.post("/api/invites/register/options", { token, displayName: "遅れた人" });
    const ra = await a.authenticator.register(oa.json, "http://localhost:5173");
    const rb = await b.authenticator.register(ob.json, "http://localhost:5173");
    expect((await a.post("/api/invites/register/verify", { token, response: ra })).status).toBe(200);
    expect((await b.post("/api/invites/register/verify", { token, response: rb })).status).toBe(400);
    const names = (await takumi.get(`/api/families/${fam.id}/members`)).json.map((m: any) => m.displayName);
    expect(names).toEqual(["たくみ", "A"]);
    const ghost = await env.DB.prepare("SELECT count(*) AS n FROM users WHERE display_name = '遅れた人'").first<{ n: number }>();
    expect(ghost?.n).toBe(0);
  });

  it("24時間で切れる", async () => {
    const takumi = await bootstrapUser("たくみ");
    const fam = (await takumi.post("/api/families", { name: "辻下家" })).json;
    const inv = (await takumi.post(`/api/families/${fam.id}/invites`)).json;
    await env.DB.prepare("UPDATE invites SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), inv.id).run();
    const token = tokenOf(inv.url, "invite");
    expect((await new TestDevice().post("/api/invites/info", { token })).json).toEqual({ valid: false });
    expect((await new TestDevice().registerViaInvite(token, "妻")).status).toBe(400);
  });

  it("アカウントを持っている人はログインして参加する。二重には入れない", async () => {
    const takumi = await bootstrapUser("たくみ");
    const fam = (await takumi.post("/api/families", { name: "実家" })).json;
    const grandma = await bootstrapUser("母");
    const token = tokenOf((await takumi.post(`/api/families/${fam.id}/invites`)).json.url, "invite");
    expect((await grandma.post("/api/invites/accept", { token })).json).toEqual({ familyId: fam.id, familyName: "実家" });
    expect((await grandma.get("/api/families")).json).toEqual([{ id: fam.id, name: "実家", role: "member" }]);

    const token2 = tokenOf((await takumi.post(`/api/families/${fam.id}/invites`)).json.url, "invite");
    expect((await grandma.post("/api/invites/info", { token: token2 })).json.alreadyMember).toBe(true);
    expect((await grandma.post("/api/invites/accept", { token: token2 })).status).toBe(409);
  });

  it("招待を出せるのは管理者だけ", async () => {
    const { wife, fam } = await familyWithWife();
    expect((await wife.post(`/api/families/${fam.id}/invites`)).status).toBe(403);
  });
});

describe("役割", () => {
  it("管理者はほかの人を管理者にでき、戻せる。管理者が0人になる変更は断る", async () => {
    const { takumi, wife, fam } = await familyWithWife();
    expect((await wife.patch(`/api/families/${fam.id}/members/${wife.userId}`, { role: "admin" })).status).toBe(403);
    expect((await takumi.patch(`/api/families/${fam.id}/members/${takumi.userId}`, { role: "member" })).status).toBe(409);

    expect((await takumi.patch(`/api/families/${fam.id}/members/${wife.userId}`, { role: "admin" })).status).toBe(200);
    expect((await takumi.patch(`/api/families/${fam.id}/members/${takumi.userId}`, { role: "member" })).status).toBe(200);
    const roles = (await wife.get(`/api/families/${fam.id}/members`)).json.map((m: any) => [m.displayName, m.role, m.isMe]);
    expect(roles).toEqual([
      ["たくみ", "member", false],
      ["妻", "admin", true],
    ]);
  });

  it("名前を変えられるのは管理者だけ", async () => {
    const { takumi, wife, fam } = await familyWithWife();
    expect((await wife.patch(`/api/families/${fam.id}`, { name: "妻の家" })).status).toBe(403);
    expect((await takumi.patch(`/api/families/${fam.id}`, { name: "つじした家" })).json.name).toBe("つじした家");
  });
});

describe("抜ける・外す", () => {
  it("メンバーは自分で抜けられる。担当だった家事は担当なしに戻り、記録は残る", async () => {
    const { takumi, wife, fam } = await familyWithWife();
    const choreId = await insertChore(fam.id, wife.userId);
    await env.DB.prepare("INSERT INTO logs (id, chore_id, family_id, user_id, done_on) VALUES ('l1', ?, ?, ?, '2026-10-05')").bind(choreId, fam.id, wife.userId).run();

    expect((await wife.del(`/api/families/${fam.id}/members/${wife.userId}`)).json).toEqual({ ok: true, familyDeleted: false });
    expect((await wife.get("/api/families")).json).toEqual([]);
    expect((await takumi.get(`/api/families/${fam.id}/members`)).json).toHaveLength(1);
    const chore = await env.DB.prepare("SELECT assignee_user_id AS a FROM chores WHERE id = ?").bind(choreId).first<{ a: string | null }>();
    expect(chore?.a).toBeNull();
    const log = await env.DB.prepare("SELECT user_id AS u FROM logs WHERE id = 'l1'").first<{ u: string }>();
    expect(log?.u).toBe(wife.userId);
  });

  it("最後の管理者は、ほかにメンバーがいるあいだは抜けられない", async () => {
    const { takumi, fam } = await familyWithWife();
    const r = await takumi.del(`/api/families/${fam.id}/members/${takumi.userId}`);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("last_admin");
  });

  it("1人だけの Family から抜けると、Family の削除になる", async () => {
    const d = await bootstrapUser();
    const fam = (await d.post("/api/families", { name: "ひとり家" })).json;
    expect((await d.del(`/api/families/${fam.id}/members/${d.userId}`)).json).toEqual({ ok: true, familyDeleted: true });
    const f = await env.DB.prepare("SELECT count(*) AS n FROM families WHERE id = ?").bind(fam.id).first<{ n: number }>();
    expect(f?.n).toBe(0);
  });

  it("管理者はメンバーを外せる。メンバーはほかの人を外せない", async () => {
    const { takumi, wife, fam } = await familyWithWife();
    expect((await wife.del(`/api/families/${fam.id}/members/${takumi.userId}`)).status).toBe(403);
    expect((await takumi.del(`/api/families/${fam.id}/members/${wife.userId}`)).status).toBe(200);
    expect((await wife.get(`/api/families/${fam.id}/members`)).status).toBe(404);
  });
});

describe("Family の削除", () => {
  it("名前の確認と step-up が要る。消すと家事・記録・招待も消える", async () => {
    const { takumi, wife, fam } = await familyWithWife();
    const choreId = await insertChore(fam.id, null);
    await env.DB.prepare("INSERT INTO logs (id, chore_id, family_id, user_id, done_on) VALUES ('l2', ?, ?, ?, '2026-10-05')").bind(choreId, fam.id, takumi.userId).run();

    expect((await wife.req("DELETE", `/api/families/${fam.id}`, { confirmName: "辻下家" })).status).toBe(403);
    const wrong = await takumi.req("DELETE", `/api/families/${fam.id}`, { confirmName: "辻下" });
    expect(wrong.json.code).toBe("confirm_name_mismatch");

    await ageSessions(takumi, "created_at", 11 * MIN);
    expect((await takumi.req("DELETE", `/api/families/${fam.id}`, { confirmName: "辻下家" })).json.code).toBe("step_up_required");
    await takumi.stepUp();
    expect((await takumi.req("DELETE", `/api/families/${fam.id}`, { confirmName: "辻下家" })).status).toBe(200);

    for (const table of ["families", "family_members", "chores", "logs", "invites"]) {
      const col = table === "families" ? "id" : "family_id";
      const n = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${col} = ?`).bind(fam.id).first<{ n: number }>();
      expect(n?.n, table).toBe(0);
    }
    expect((await wife.get("/api/families")).json).toEqual([]);
  });
});

describe("回復の札", () => {
  it("管理者が、端末をなくしたメンバーのために札を出せる。入った端末には「だれが出した札か」が残る", async () => {
    const { takumi, wife, fam } = await familyWithWife();
    const r = await takumi.post(`/api/families/${fam.id}/members/${wife.userId}/recovery-ticket`);
    expect(r.status).toBe(200);
    const token = tokenOf(r.json.url, "login");

    const newPhone = new TestDevice();
    expect((await newPhone.post("/api/auth/ticket-info", { token })).json).toEqual({ valid: true, kind: "recovery" });
    expect((await newPhone.redeem(token)).status).toBe(200);
    expect((await newPhone.get("/api/me")).json).toMatchObject({ user: { displayName: "妻" }, session: { via: "recovery_ticket", stepUpOk: true } });

    // 入った直後なので、新しいパスキーを作れる
    expect((await newPhone.registerPasskey()).status).toBe(200);

    const sessions = (await wife.get("/api/me/sessions")).json;
    expect(sessions.find((s: any) => s.via === "recovery_ticket")).toMatchObject({ issuedBy: "たくみ" });
    expect((await takumi.get(`/api/me/tickets/${r.json.id}`)).json.used).toBe(true);
  });

  it("メンバーは出せない。自分のためにも出せない。step-up が要る", async () => {
    const { takumi, wife, fam } = await familyWithWife();
    expect((await wife.post(`/api/families/${fam.id}/members/${takumi.userId}/recovery-ticket`)).status).toBe(403);
    expect((await takumi.post(`/api/families/${fam.id}/members/${takumi.userId}/recovery-ticket`)).status).toBe(400);
    await ageSessions(takumi, "created_at", 11 * MIN);
    expect((await takumi.post(`/api/families/${fam.id}/members/${wife.userId}/recovery-ticket`)).json.code).toBe("step_up_required");
  });

  it("よその Family の人のためには出せない", async () => {
    const { takumi, fam } = await familyWithWife();
    const stranger = await bootstrapUser("他人");
    expect((await takumi.post(`/api/families/${fam.id}/members/${stranger.userId}/recovery-ticket`)).status).toBe(404);
  });
});
