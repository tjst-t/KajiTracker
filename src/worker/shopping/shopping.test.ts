import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { TestDevice, bootstrapUser } from "../../../test/client";
import { DEFAULT_SECTIONS } from "./defaults";

type Lists = { id: string; name: string; sortOrder: number; openCount: number; cartCount: number }[];
type Section = { id: string; name: string; sortOrder: number };
type Item = { id: string; name: string; note: string | null; sectionId: string | null; status: string; addedByName: string | null; cartByName: string | null };
type Frequent = { name: string; count: number; lastBoughtAt: string; sectionId: string | null };
type ListView = { list: { id: string; name: string }; lists: Lists; sections: Section[]; items: Item[]; frequent: Frequent[] };

const rid = () => crypto.randomUUID().replace(/-/g, "");

async function setup() {
  const takumi = await bootstrapUser("たくみ");
  const fam = (await takumi.post("/api/families", { name: "辻下家" })).json;
  const inv = (await takumi.post(`/api/families/${fam.id}/invites`)).json;
  const wife = new TestDevice();
  await wife.registerViaInvite(inv.url.split("#invite=")[1], "はなこ");
  const lists = async (d: TestDevice = takumi) => (await d.get(`/api/families/${fam.id}/shopping-lists`)).json as Lists;
  const [super_, costco] = await lists();
  const view = async (listId: string, d: TestDevice = takumi) => (await d.get(`/api/shopping-lists/${listId}`)).json as ListView;
  const section = async (listId: string, name: string) => (await view(listId)).sections.find((s) => s.name === name)!.id;
  const add = (listId: string, b: object, d: TestDevice = takumi) => d.post(`/api/shopping-lists/${listId}/items`, b);
  return { takumi, wife, fam, lists, view, section, add, superId: super_!.id, costcoId: costco!.id };
}

describe("買い物のリストと売り場", () => {
  it("Family を作ると、スーパー・コストコ・IKEA があり、それぞれに最初の売り場が入っている", async () => {
    const { lists, view } = await setup();
    const ls = await lists();
    expect(ls.map((l) => l.name)).toEqual(["スーパー", "コストコ", "IKEA"]);
    expect(ls[0]).toMatchObject({ openCount: 0, cartCount: 0 });
    for (const l of ls) expect((await view(l.id)).sections.map((s) => s.name)).toEqual(DEFAULT_SECTIONS);
  });

  it("マイグレーションで、すでにある Family にも最初のリストと売り場が入る", async () => {
    const fid = rid();
    await env.DB.prepare("INSERT INTO families (id, name) VALUES (?, '前からある家')").bind(fid).run();
    const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0004_shopping"))!;
    for (const q of m.queries.filter((q) => q.includes("INSERT INTO"))) await env.DB.prepare(q).run();
    const ls = await env.DB.prepare("SELECT id, name FROM shopping_lists WHERE family_id = ? ORDER BY sort_order").bind(fid).all<{ id: string; name: string }>();
    expect(ls.results.map((l) => l.name)).toEqual(["スーパー", "コストコ", "IKEA"]);
    for (const l of ls.results) {
      const s = await env.DB.prepare("SELECT name FROM shopping_sections WHERE list_id = ? ORDER BY sort_order").bind(l.id).all<{ name: string }>();
      expect(s.results.map((r) => r.name)).toEqual(DEFAULT_SECTIONS);
    }
  });

  it("リストを足す・名前を変える・並べ替える・消す（新しいリストにも最初の売り場）", async () => {
    const { wife, fam, lists, view, superId } = await setup();
    const r = await wife.post(`/api/families/${fam.id}/shopping-lists`, { name: " ドラッグストア " });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: "ドラッグストア", sortOrder: 3 });
    expect((await view(r.json.id)).sections).toHaveLength(DEFAULT_SECTIONS.length);
    expect((await wife.patch(`/api/shopping-lists/${r.json.id}`, { name: "薬局", sortOrder: -1 })).status).toBe(200);
    expect((await lists()).map((l) => l.name)).toEqual(["薬局", "スーパー", "コストコ", "IKEA"]);
    expect((await wife.post(`/api/families/${fam.id}/shopping-lists`, { name: "" })).status).toBe(400);
    expect((await wife.post(`/api/families/${fam.id}/shopping-lists`, { name: "あ".repeat(21) })).status).toBe(400);
    expect((await wife.patch(`/api/shopping-lists/${superId}`, { sortOrder: 1.5 })).status).toBe(400);
    expect((await wife.del(`/api/shopping-lists/${r.json.id}`)).status).toBe(200);
    expect((await lists()).map((l) => l.name)).toEqual(["スーパー", "コストコ", "IKEA"]);
    expect((await wife.get(`/api/shopping-lists/${r.json.id}`)).status).toBe(404);
  });

  it("売り場を足す・直す・消す。消した売り場の品物は売り場なしになる", async () => {
    const { takumi, view, add, superId, section } = await setup();
    const r = await takumi.post(`/api/shopping-lists/${superId}/sections`, { name: "お惣菜" });
    expect(r.status).toBe(201);
    expect(r.json.sortOrder).toBe(DEFAULT_SECTIONS.length);
    expect((await takumi.patch(`/api/shopping-sections/${r.json.id}`, { name: "惣菜", sortOrder: -1 })).status).toBe(200);
    expect((await view(superId)).sections[0]).toMatchObject({ id: r.json.id, name: "惣菜" });
    const veg = await section(superId, "野菜・果物");
    const item = (await add(superId, { name: "にんじん", sectionId: veg })).json;
    expect((await takumi.del(`/api/shopping-sections/${veg}`)).status).toBe(200);
    const v = await view(superId);
    expect(v.sections.find((s) => s.id === veg)).toBeUndefined();
    expect(v.items.find((i) => i.id === item.id)).toMatchObject({ sectionId: null });
    expect((await takumi.post(`/api/shopping-lists/${superId}/sections`, { name: " " })).status).toBe(400);
  });

  it("よその Family の人は、リスト・売り場・品物を見ることも触ることもできない", async () => {
    const { fam, add, superId, section } = await setup();
    const item = (await add(superId, { name: "牛乳" })).json;
    const sec = await section(superId, "飲み物");
    const other = await bootstrapUser("よそ");
    expect((await other.get(`/api/families/${fam.id}/shopping-lists`)).status).toBe(404);
    expect((await other.post(`/api/families/${fam.id}/shopping-lists`, { name: "x" })).status).toBe(404);
    expect((await other.get(`/api/shopping-lists/${superId}`)).status).toBe(404);
    expect((await other.patch(`/api/shopping-lists/${superId}`, { name: "x" })).status).toBe(404);
    expect((await other.del(`/api/shopping-lists/${superId}`)).status).toBe(404);
    expect((await other.post(`/api/shopping-lists/${superId}/sections`, { name: "x" })).status).toBe(404);
    expect((await other.patch(`/api/shopping-sections/${sec}`, { name: "x" })).status).toBe(404);
    expect((await other.del(`/api/shopping-sections/${sec}`)).status).toBe(404);
    expect((await other.post(`/api/shopping-lists/${superId}/items`, { name: "x" })).status).toBe(404);
    expect((await other.patch(`/api/shopping-items/${item.id}`, { status: "in_cart" })).status).toBe(404);
    expect((await other.del(`/api/shopping-items/${item.id}`)).status).toBe(404);
    expect((await other.post(`/api/shopping-lists/${superId}/checkout`, {})).status).toBe(404);
    expect((await other.get(`/api/shopping-lists/${superId}/purchases`)).status).toBe(404);
    // よその人のリストに、よその売り場の id で入れることもできない
    const otherFam = (await other.post("/api/families", { name: "よそ家" })).json;
    const [otherList] = (await other.get(`/api/families/${otherFam.id}/shopping-lists`)).json as Lists;
    expect((await other.post(`/api/shopping-lists/${otherList!.id}/items`, { name: "x", sectionId: sec })).status).toBe(400);
    // 同じ id を、よそのリストで使うことはできない（もとの品物は変わらない）
    expect((await other.post(`/api/shopping-lists/${otherList!.id}/items`, { id: item.id, name: "x" })).status).toBe(409);
    expect((await (await setupView(other, otherList!.id)).items).length).toBe(0);
  });
});

const setupView = async (d: TestDevice, listId: string) => (await d.get(`/api/shopping-lists/${listId}`)).json as ListView;

describe("品物", () => {
  it("足すと、名前・数量メモ・売り場・入れた人つきで出る。リストの数にも出る", async () => {
    const { wife, view, lists, add, superId, section } = await setup();
    const milk = await section(superId, "乳製品・卵");
    const r = await add(superId, { name: " 牛乳 ", note: " 2本 ", sectionId: milk }, wife);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: "牛乳", note: "2本", sectionId: milk, status: "open", addedByName: "はなこ", cartByName: null });
    expect((await view(superId)).items).toHaveLength(1);
    expect((await lists())[0]).toMatchObject({ openCount: 1, cartCount: 0 });
    expect((await lists())[1]).toMatchObject({ openCount: 0 });
  });

  it("名前は1〜40文字、数量メモは40文字まで、売り場はそのリストのものだけ", async () => {
    const { add, superId, costcoId, section } = await setup();
    expect((await add(superId, { name: "" })).status).toBe(400);
    expect((await add(superId, { name: "あ".repeat(41) })).status).toBe(400);
    expect((await add(superId, { name: "🥛".repeat(40) })).status).toBe(201);
    expect((await add(superId, { name: "卵", note: "x".repeat(41) })).status).toBe(400);
    expect((await add(superId, { name: "卵", sectionId: await section(costcoId, "肉・魚") })).status).toBe(400);
    expect((await add(superId, { name: "卵", id: "短い" })).status).toBe(400);
  });

  it("同じ id で2回足しても1件。2回目は 200 で、中身は変えない", async () => {
    const { wife, view, add, superId } = await setup();
    const id = rid();
    const a = await add(superId, { id, name: "牛乳", note: "1本" });
    expect(a.status).toBe(201);
    const b = await add(superId, { id, name: "牛乳", note: "1本" }, wife);
    expect(b.status).toBe(200);
    expect(b.json).toMatchObject({ id, note: "1本", addedByName: "たくみ" });
    // 同時に送っても1件
    const id2 = rid();
    const both = await Promise.all([add(superId, { id: id2, name: "卵" }), add(superId, { id: id2, name: "卵" }, wife)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 201]);
    expect((await view(superId)).items.map((i) => i.id)).toEqual([id, id2]);
  });

  it("状態は、なってほしい状態を送る。2回送っても同じで、カゴに入れた人は最初の人のまま", async () => {
    const { takumi, wife, view, lists, add, superId } = await setup();
    const { id } = (await add(superId, { name: "牛乳" })).json;
    const r1 = await wife.patch(`/api/shopping-items/${id}`, { status: "in_cart" });
    expect(r1.json).toMatchObject({ status: "in_cart", cartByName: "はなこ" });
    const r2 = await takumi.patch(`/api/shopping-items/${id}`, { status: "in_cart" });
    expect(r2.json).toMatchObject({ status: "in_cart", cartByName: "はなこ" });
    expect((await lists())[0]).toMatchObject({ openCount: 0, cartCount: 1 });
    // もう一度タップで戻す（2回送っても同じ）
    for (let i = 0; i < 2; i++) expect((await wife.patch(`/api/shopping-items/${id}`, { status: "open" })).json).toMatchObject({ status: "open", cartByName: null });
    expect((await view(superId)).items[0]).toMatchObject({ status: "open" });
    expect((await wife.patch(`/api/shopping-items/${id}`, { status: "bought" })).status).toBe(400);
  });

  it("名前・数量メモ・売り場を直せる。最後に書いた方が勝ち", async () => {
    const { takumi, wife, add, superId, section } = await setup();
    const { id } = (await add(superId, { name: "牛乳" })).json;
    await takumi.patch(`/api/shopping-items/${id}`, { note: "1本" });
    await wife.patch(`/api/shopping-items/${id}`, { note: "2本", sectionId: await section(superId, "乳製品・卵") });
    const r = await takumi.patch(`/api/shopping-items/${id}`, { name: "低脂肪乳", note: null });
    expect(r.json).toMatchObject({ name: "低脂肪乳", note: null, sectionId: await section(superId, "乳製品・卵") });
  });

  it("消すのは2回送っても 200。消えた品物を直そうとすると 404", async () => {
    const { takumi, wife, view, add, superId } = await setup();
    const { id } = (await add(superId, { name: "牛乳" })).json;
    expect((await takumi.del(`/api/shopping-items/${id}`)).json).toEqual({ ok: true, deleted: true });
    expect((await wife.del(`/api/shopping-items/${id}`)).json).toEqual({ ok: true, deleted: false });
    expect((await view(superId)).items).toHaveLength(0);
    expect((await wife.patch(`/api/shopping-items/${id}`, { status: "in_cart" })).status).toBe(404);
  });
});

describe("買い物を終える・よく買うもの", () => {
  it("カゴに入れたものだけがリストから外れ、履歴に（名前・売り場・リスト・日時・誰）残る", async () => {
    const { takumi, wife, view, lists, add, superId, section } = await setup();
    const dairy = await section(superId, "乳製品・卵");
    const milk = (await add(superId, { name: "牛乳", note: "2本", sectionId: dairy })).json;
    const egg = (await add(superId, { name: "卵", sectionId: dairy })).json;
    const bread = (await add(superId, { name: "食パン" })).json;
    await wife.patch(`/api/shopping-items/${milk.id}`, { status: "in_cart" });
    await takumi.patch(`/api/shopping-items/${egg.id}`, { status: "in_cart" });

    const r = await wife.post(`/api/shopping-lists/${superId}/checkout`, {});
    expect(r.status).toBe(200);
    expect(r.json.purchased).toBe(2);
    expect((await view(superId)).items.map((i) => i.id)).toEqual([bread.id]);
    expect((await lists())[0]).toMatchObject({ openCount: 1, cartCount: 0 });

    const h = (await takumi.get(`/api/shopping-lists/${superId}/purchases`)).json as Record<string, unknown>[];
    expect(h).toHaveLength(2);
    expect(h.find((p) => p.name === "牛乳")).toMatchObject({ note: "2本", sectionId: dairy, sectionName: "乳製品・卵", listName: "スーパー", userName: "はなこ" });
    expect(h.find((p) => p.name === "卵")).toMatchObject({ userName: "たくみ" });
    expect(Date.parse(h[0]!.boughtAt as string)).toBeGreaterThan(Date.now() - 60_000);

    // もう一度送っても、何も増えない
    expect((await wife.post(`/api/shopping-lists/${superId}/checkout`, {})).json.purchased).toBe(0);
    expect((await takumi.get(`/api/shopping-lists/${superId}/purchases`)).json).toHaveLength(2);
  });

  it("itemIds を送ると、そのうちカゴにあるものだけを終える（あとからカゴに入れたものは残る）", async () => {
    const { takumi, wife, view, add, superId } = await setup();
    const a = (await add(superId, { name: "牛乳" })).json;
    const b = (await add(superId, { name: "卵" })).json;
    await takumi.patch(`/api/shopping-items/${a.id}`, { status: "in_cart" });
    await wife.patch(`/api/shopping-items/${b.id}`, { status: "in_cart" });
    for (let i = 0; i < 2; i++) await takumi.post(`/api/shopping-lists/${superId}/checkout`, { itemIds: [a.id] });
    expect((await view(superId)).items.map((i) => i.name)).toEqual(["卵"]);
    expect((await takumi.get(`/api/shopping-lists/${superId}/purchases`)).json).toHaveLength(1);
    expect((await takumi.post(`/api/shopping-lists/${superId}/checkout`, { itemIds: "x" })).status).toBe(400);
  });

  it("よく買うもの：回数の多い順・同じなら新しい順。リストにあるものは出さない。リストごとに別", async () => {
    const { takumi, view, add, superId, costcoId } = await setup();
    const buy = async (listId: string, names: string[]) => {
      for (const name of names) {
        const { id } = (await add(listId, { name })).json;
        await takumi.patch(`/api/shopping-items/${id}`, { status: "in_cart" });
      }
      await takumi.post(`/api/shopping-lists/${listId}/checkout`, {});
    };
    await buy(superId, ["牛乳", "卵", "バナナ"]);
    await buy(superId, ["牛乳", "納豆"]);
    await buy(superId, ["卵"]);
    await buy(costcoId, ["トイレットペーパー"]);
    // 牛乳・卵は2回（卵のほうが新しい）、納豆・バナナは1回（納豆のほうが新しい）
    expect((await view(superId)).frequent.map((f) => [f.name, f.count])).toEqual([
      ["卵", 2],
      ["牛乳", 2],
      ["納豆", 1],
      ["バナナ", 1],
    ]);
    expect((await view(costcoId)).frequent.map((f) => f.name)).toEqual(["トイレットペーパー"]);
    await add(superId, { name: "牛乳" });
    expect((await view(superId)).frequent.map((f) => f.name)).toEqual(["卵", "納豆", "バナナ"]);
  });

  it("前に買ったときの売り場を覚えていて、売り場を送らずに入れるとそこに入る（null なら売り場なし）", async () => {
    const { takumi, view, add, superId, section } = await setup();
    const dairy = await section(superId, "乳製品・卵");
    const drink = await section(superId, "飲み物");
    const buy = async (sectionId: string) => {
      const { id } = (await add(superId, { name: "牛乳", sectionId })).json;
      await takumi.patch(`/api/shopping-items/${id}`, { status: "in_cart" });
      await takumi.post(`/api/shopping-lists/${superId}/checkout`, {});
    };
    await buy(drink);
    await buy(dairy);
    // いちばん新しいときの売り場
    expect((await view(superId)).frequent[0]).toMatchObject({ name: "牛乳", sectionId: dairy });
    const r = await add(superId, { name: "牛乳" });
    expect(r.json.sectionId).toBe(dairy);
    await takumi.del(`/api/shopping-items/${r.json.id}`);
    expect((await add(superId, { name: "牛乳", sectionId: null })).json.sectionId).toBeNull();
    // 前に買ったことの無いものは売り場なし
    expect((await add(superId, { name: "豆腐" })).json.sectionId).toBeNull();
  });
});
