import { describe, expect, it } from "vitest";
import { todayInTokyo } from "../../shared/date";
import { bootstrapUser } from "../../../test/client";

const today = () => todayInTokyo();
const interval = (intervalDays: number) => ({ type: "interval", intervalDays, firstDueOn: today() });

async function setup() {
  const d = await bootstrapUser();
  const fam = (await d.post("/api/families", { name: "辻下家" })).json;
  const groups = (await d.get(`/api/families/${fam.id}/groups`)).json as { id: string; name: string }[];
  const byName = Object.fromEntries(groups.map((g) => [g.name, g.id]));
  return { d, fam, groups, byName };
}

describe("グループ", () => {
  it("Family を作ると、最初から6つのグループがある", async () => {
    const { groups } = await setup();
    expect(groups.map((g) => g.name)).toEqual(["キッチン", "風呂", "トイレ", "洗濯", "ゴミ捨て", "掃除"]);
  });

  it("足す・名前を変える。家事に付けると一覧と詳細にグループ名が出る", async () => {
    const { d, fam, byName } = await setup();
    const g = (await d.post(`/api/families/${fam.id}/groups`, { name: "庭" })).json;
    expect(g.sortOrder).toBe(6);
    expect((await d.patch(`/api/groups/${byName["風呂"]}`, { name: "お風呂" })).status).toBe(200);

    const chore = (await d.post(`/api/families/${fam.id}/chores`, { name: "排水口", schedule: interval(7), groupId: byName["風呂"] })).json;
    expect(chore).toMatchObject({ groupId: byName["風呂"], groupName: "お風呂" });
    expect((await d.get(`/api/families/${fam.id}/chores`)).json.chores[0].groupName).toBe("お風呂");
    expect((await d.get(`/api/chores/${chore.id}`)).json.groupName).toBe("お風呂");

    await d.patch(`/api/chores/${chore.id}`, { groupId: null });
    expect((await d.get(`/api/chores/${chore.id}`)).json).toMatchObject({ groupId: null, groupName: null });
  });

  it("グループを消すと、入っていた家事はグループ無しになる（家事は残る）", async () => {
    const { d, fam, byName } = await setup();
    const chore = (await d.post(`/api/families/${fam.id}/chores`, { name: "排水口", schedule: interval(7), groupId: byName["キッチン"] })).json;
    expect((await d.del(`/api/groups/${byName["キッチン"]}`)).status).toBe(200);
    expect((await d.get(`/api/chores/${chore.id}`)).json).toMatchObject({ name: "排水口", groupId: null });
    expect((await d.get(`/api/families/${fam.id}/groups`)).json).toHaveLength(5);
  });

  it("よその Family のグループは付けられず、触れない", async () => {
    const a = await setup();
    const b = await setup();
    const r = await a.d.post(`/api/families/${a.fam.id}/chores`, { name: "x", schedule: interval(7), groupId: b.byName["風呂"] });
    expect(r.status).toBe(400);
    expect((await a.d.patch(`/api/groups/${b.byName["風呂"]}`, { name: "x" })).status).toBe(404);
    expect((await a.d.del(`/api/groups/${b.byName["風呂"]}`)).status).toBe(404);
  });

  it("名前が空・長すぎるなら断る", async () => {
    const { d, fam } = await setup();
    expect((await d.post(`/api/families/${fam.id}/groups`, { name: "" })).status).toBe(400);
    expect((await d.post(`/api/families/${fam.id}/groups`, { name: "あ".repeat(21) })).status).toBe(400);
  });
});

describe("まとめて登録", () => {
  it("複数の家事を一度に登録できる（日数・毎週・グループ・担当）", async () => {
    const { d, fam, byName } = await setup();
    const r = await d.post(`/api/families/${fam.id}/chores/bulk`, {
      chores: [
        { name: "シンクの排水口", schedule: interval(7), groupId: byName["キッチン"] },
        { name: "燃えるゴミ", schedule: { type: "calendar", rule: { kind: "weekly", weekdays: [1, 4] } }, groupId: byName["ゴミ捨て"], assigneeUserId: d.userId },
        { name: "窓ふき", schedule: interval(90) },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.json.created).toBe(3);
    const list = (await d.get(`/api/families/${fam.id}/chores`)).json.chores;
    expect(list.map((c: any) => [c.name, c.groupName]).sort()).toEqual([
      ["シンクの排水口", "キッチン"],
      ["燃えるゴミ", "ゴミ捨て"],
      ["窓ふき", null],
    ]);
  });

  it("1行でも不備があれば1件も入れず、不備のある行と理由を返す", async () => {
    const { d, fam } = await setup();
    const r = await d.post(`/api/families/${fam.id}/chores/bulk`, {
      chores: [{ name: "よい家事", schedule: interval(7) }, { name: "", schedule: interval(7) }, { name: "日数がない", schedule: interval(0) }],
    });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("bulk_invalid");
    expect(r.json.rows.map((e: any) => e.index)).toEqual([1, 2]);
    expect(r.json.rows[0].message).toContain("家事の名前");
    expect((await d.get(`/api/families/${fam.id}/chores`)).json.chores).toHaveLength(0);
  });

  it("空や多すぎるのは断る。メンバーでなければ 404", async () => {
    const { d, fam } = await setup();
    expect((await d.post(`/api/families/${fam.id}/chores/bulk`, { chores: [] })).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => ({ name: `家事${i}`, schedule: interval(7) }));
    expect((await d.post(`/api/families/${fam.id}/chores/bulk`, { chores: many })).status).toBe(400);
    const stranger = await bootstrapUser("他人");
    expect((await stranger.post(`/api/families/${fam.id}/chores/bulk`, { chores: [{ name: "x", schedule: interval(7) }] })).status).toBe(404);
  });
});
