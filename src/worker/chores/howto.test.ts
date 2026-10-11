import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { todayInTokyo } from "../../shared/date";
import { TestDevice, bootstrapUser } from "../../../test/client";

const interval = { type: "interval", intervalDays: 7, firstDueOn: todayInTokyo() };

async function setup() {
  const takumi = await bootstrapUser("たくみ");
  const fam = (await takumi.post("/api/families", { name: "辻下家" })).json;
  const inv = (await takumi.post(`/api/families/${fam.id}/invites`)).json;
  const wife = new TestDevice();
  await wife.registerViaInvite(inv.url.split("#invite=")[1], "はなこ");
  const add = (b: object, d: TestDevice = takumi) => d.post(`/api/families/${fam.id}/chores`, { name: "排水口", schedule: interval, ...b });
  const get = async (id: string, d: TestDevice = takumi) => (await d.get(`/api/chores/${id}`)).json;
  const list = async () => (await takumi.get(`/api/families/${fam.id}/chores`)).json.chores as Record<string, unknown>[];
  const row = (id: string) => env.DB.prepare("SELECT howto_updated_at AS at, howto_updated_by AS by FROM chores WHERE id = ?").bind(id).first<{ at: string | null; by: string | null }>();
  return { takumi, wife, fam, add, get, list, row };
}

describe("家事のやり方（Markdown）", () => {
  it("登録で書いたやり方が、詳細と一覧に、書いた人と日時つきで出る", async () => {
    const { takumi, add, get, list } = await setup();
    const r = await add({ howto: "## 手順\r\n- [ ] ふたを外す\r\n- [ ] **ぬめり**を落とす" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ hasHowto: true, howtoUpdatedByName: "たくみ" });
    const d = await get(r.json.id);
    // 改行は \n にそろえる
    expect(d.howto).toBe("## 手順\n- [ ] ふたを外す\n- [ ] **ぬめり**を落とす");
    expect(d.howtoUpdatedByName).toBe("たくみ");
    expect(Date.parse(d.howtoUpdatedAt)).toBeGreaterThan(Date.now() - 60_000);
    const [c] = await list();
    expect(c).toMatchObject({ hasHowto: true, howto: d.howto, howtoUpdatedByName: "たくみ" });
    expect(takumi.userId).toBeTruthy();
  });

  it("やり方が無ければ null、空白だけも null", async () => {
    const { add, get } = await setup();
    const a = await add({});
    expect(await get(a.json.id)).toMatchObject({ howto: null, hasHowto: false, howtoUpdatedAt: null, howtoUpdatedByName: null });
    const b = await add({ howto: "  \n " });
    expect(await get(b.json.id)).toMatchObject({ howto: null, hasHowto: false, howtoUpdatedAt: null });
  });

  it("PATCH で直すと、変わったときだけ直した人と日時を更新する", async () => {
    const { takumi, wife, add, get, row } = await setup();
    const { id } = (await add({ howto: "- 洗う" })).json;
    const first = await row(id);
    expect(first?.by).toBe(takumi.userId);

    // 同じ中身・ほかの項目だけ：変えない
    expect((await wife.patch(`/api/chores/${id}`, { howto: "- 洗う", name: "排水口そうじ" })).status).toBe(200);
    expect(await row(id)).toEqual(first);
    expect((await get(id)).howtoUpdatedByName).toBe("たくみ");

    // 中身が変われば、はなこが直したことになる
    expect((await wife.patch(`/api/chores/${id}`, { howto: "- 洗う\n- 乾かす" })).status).toBe(200);
    const d = await get(id);
    expect(d).toMatchObject({ howto: "- 洗う\n- 乾かす", howtoUpdatedByName: "はなこ" });
    expect(d.howtoUpdatedAt >= first!.at!).toBe(true);

    // 消すのも記録する
    expect((await takumi.patch(`/api/chores/${id}`, { howto: "" })).status).toBe(200);
    expect(await get(id)).toMatchObject({ howto: null, hasHowto: false, howtoUpdatedByName: "たくみ" });
  });

  it("表で編集（PATCH bulk）でも、足す・直すでやり方を受け付ける", async () => {
    const { takumi, wife, fam, add, get, row } = await setup();
    const a = (await add({ howto: "元のまま" })).json.id;
    const b = (await add({ name: "風呂" })).json.id;
    const before = await row(a);
    const r = await wife.patch(`/api/families/${fam.id}/chores/bulk`, {
      create: [{ name: "窓ふき", schedule: interval, howto: "1. 上から\n2. 下へ" }],
      chores: [
        { id: a, howto: "元のまま", name: "排水口2" },
        { id: b, howto: "| 道具 | 場所 |\n| --- | --- |\n| ブラシ | 棚 |" },
      ],
    });
    expect(r.status).toBe(200);
    expect(await row(a)).toEqual(before);
    expect(await get(b)).toMatchObject({ hasHowto: true, howtoUpdatedByName: "はなこ" });
    const list = (await takumi.get(`/api/families/${fam.id}/chores`)).json.chores as { name: string; howto: string; howtoUpdatedByName: string }[];
    expect(list.find((c) => c.name === "窓ふき")).toMatchObject({ howto: "1. 上から\n2. 下へ", howtoUpdatedByName: "はなこ" });
  });

  it("長さの上限は 10000 文字（絵文字も1文字と数える）。超えたら断る", async () => {
    const { fam, takumi, add } = await setup();
    expect((await add({ howto: "あ".repeat(10000) })).status).toBe(201);
    expect((await add({ howto: "🧽".repeat(10000) })).status).toBe(201);
    const over = await add({ howto: "あ".repeat(10001) });
    expect(over.status).toBe(400);
    expect(over.json.error).toContain("10000");
    const { id } = (await add({})).json;
    expect((await takumi.patch(`/api/chores/${id}`, { howto: "x".repeat(10001) })).status).toBe(400);
    expect((await takumi.patch(`/api/chores/${id}`, { howto: 123 })).status).toBe(400);
    const bulk = await takumi.patch(`/api/families/${fam.id}/chores/bulk`, { chores: [{ id, howto: "x".repeat(10001) }] });
    expect(bulk.status).toBe(400);
    expect(bulk.json.rows).toEqual([{ kind: "update", index: 0, message: expect.stringContaining("10000") }]);
  });

  it("HTML はそのまま預かって返す（画面では HTML として出さない。markdown.test.ts）", async () => {
    const { add, get } = await setup();
    const html = '<script>alert(1)</script>\n<img src=x onerror="alert(2)">\n[押す](javascript:alert(3))';
    const { id } = (await add({ howto: html })).json;
    expect((await get(id)).howto).toBe(html);
  });

  it("よその Family の人は、やり方を見ることも直すこともできない", async () => {
    const { add } = await setup();
    const { id } = (await add({ howto: "ひみつ" })).json;
    const other = await bootstrapUser("よそ");
    expect((await other.get(`/api/chores/${id}`)).status).toBe(404);
    expect((await other.patch(`/api/chores/${id}`, { howto: "書きかえ" })).status).toBe(404);
  });
});
