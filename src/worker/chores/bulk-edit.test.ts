import { describe, expect, it } from "vitest";
import { addDays, todayInTokyo } from "../../shared/date";
import { TestDevice, bootstrapUser } from "../../../test/client";

const today = () => todayInTokyo();
const interval = (intervalDays: number, firstDueOn = today()) => ({ type: "interval", intervalDays, firstDueOn });

async function setup() {
  const takumi = await bootstrapUser("たくみ");
  const fam = (await takumi.post("/api/families", { name: "辻下家" })).json;
  const inv = (await takumi.post(`/api/families/${fam.id}/invites`)).json;
  const wife = new TestDevice();
  await wife.registerViaInvite(inv.url.split("#invite=")[1], "はなこ");
  const groups = (await takumi.get(`/api/families/${fam.id}/groups`)).json as { id: string; name: string }[];
  const byName = Object.fromEntries(groups.map((g) => [g.name, g.id]));
  const add = async (name: string, b: object = {}) => (await takumi.post(`/api/families/${fam.id}/chores`, { name, schedule: interval(7), ...b })).json as { id: string };
  const get = async (id: string) => (await takumi.get(`/api/chores/${id}`)).json;
  const bulk = (chores: unknown[], d: TestDevice = takumi) => d.patch(`/api/families/${fam.id}/chores/bulk`, { chores });
  return { takumi, wife, fam, byName, add, get, bulk };
}

describe("家事をまとめて直す（PATCH /families/:fid/chores/bulk）", () => {
  it("担当・グループ・周期・名前・通知・しまうを、何件も一度に変える。来なかった項目は変えない", async () => {
    const { wife, byName, add, get, bulk } = await setup();
    const a = await add("ゴミ出し", { notifyTime: "07:00" });
    const b = await add("風呂掃除");
    const c = await add("窓ふき");
    const r = await bulk([
      { id: a.id, assigneeUserId: wife.userId, groupId: byName["ゴミ捨て"] },
      { id: b.id, assigneeUserId: wife.userId, schedule: interval(3, addDays(today(), 2)), name: "お風呂", notifyTime: "21:15" },
      { id: c.id, assigneeUserId: wife.userId, archived: true },
    ]);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ updated: 3 });
    expect(await get(a.id)).toMatchObject({ name: "ゴミ出し", assigneeName: "はなこ", groupName: "ゴミ捨て", notifyTime: "07:00", schedule: { intervalDays: 7 } });
    expect(await get(b.id)).toMatchObject({ name: "お風呂", assigneeName: "はなこ", notifyTime: "21:15", schedule: { intervalDays: 3 }, dueOn: addDays(today(), 2) });
    expect(await get(c.id)).toMatchObject({ assigneeUserId: wife.userId, archived: true });

    // しまったものを戻す・担当とグループを外す
    expect((await bulk([{ id: c.id, archived: false, assigneeUserId: null }, { id: a.id, groupId: null }])).status).toBe(200);
    expect(await get(c.id)).toMatchObject({ archived: false, assigneeUserId: null });
    expect(await get(a.id)).toMatchObject({ groupId: null });
  });

  it("1行でも不備があれば1件も変えず、不備のある行を返す", async () => {
    const { wife, add, get, bulk } = await setup();
    const a = await add("ゴミ出し");
    const b = await add("風呂掃除");
    const stranger = await bootstrapUser("他人");
    const r = await bulk([
      { id: a.id, assigneeUserId: wife.userId, name: "燃えるゴミ" },
      { id: b.id, schedule: interval(0) },
      { id: b.id, assigneeUserId: stranger.userId },
      { id: a.id, notifyTime: "07:10" },
    ]);
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("bulk_invalid");
    expect(r.json.rows.map((x: { index: number }) => x.index)).toEqual([1, 2, 3]);
    expect(r.json.rows[1].message).toContain("2回");
    expect(await get(a.id)).toMatchObject({ name: "ゴミ出し", assigneeUserId: null });
    expect(await get(b.id)).toMatchObject({ schedule: { intervalDays: 7 } });
  });

  it("よその Family の家事・無い家事を含むと、1件も変えずに 400。よその人は 404", async () => {
    const { fam, add, get, bulk } = await setup();
    const mine = await add("ゴミ出し");
    const other = await bootstrapUser("他人");
    const otherFam = (await other.post("/api/families", { name: "よその家" })).json;
    const theirs = (await other.post(`/api/families/${otherFam.id}/chores`, { name: "よその家事", schedule: interval(7) })).json;

    const r = await bulk([{ id: mine.id, name: "x" }, { id: theirs.id, name: "乗っ取り" }, { id: "nope" }, { name: "id なし" }]);
    expect(r.status).toBe(400);
    expect(r.json.rows).toEqual([
      { index: 1, message: "その家事はありません" },
      { index: 2, message: "その家事はありません" },
      { index: 3, message: "その家事はありません" },
    ]);
    expect((await get(mine.id)).name).toBe("ゴミ出し");
    expect((await other.get(`/api/chores/${theirs.id}`)).json.name).toBe("よその家事");

    expect((await other.patch(`/api/families/${fam.id}/chores/bulk`, { chores: [{ id: mine.id, name: "x" }] })).status).toBe(404);
    expect((await get(mine.id)).name).toBe("ゴミ出し");
  });

  it("毎週・毎月の周期を変えて基準日が来なければ、前の基準日を引き継ぐ（PATCH /chores/:id と同じ）", async () => {
    const { add, get, bulk } = await setup();
    const anchor = addDays(today(), -14);
    const a = await add("シーツ", { schedule: { type: "calendar", rule: { kind: "weekly", weekdays: [1], anchor } } });
    const r = await bulk([{ id: a.id, schedule: { type: "calendar", rule: { kind: "weekly", weekdays: [2, 5] } } }]);
    expect(r.status).toBe(200);
    expect((await get(a.id)).schedule.rule).toMatchObject({ weekdays: [2, 5], every: 1, anchor });
    // 隔週にするなら基準日が要る
    const r2 = await bulk([{ id: a.id, schedule: { type: "calendar", rule: { kind: "weekly", weekdays: [2], every: 2 } } }]);
    expect(r2.json.rows[0].message).toContain("最初の予定日");
  });

  it("空・多すぎるときは断る", async () => {
    const { add, bulk } = await setup();
    const a = await add("x");
    expect((await bulk([])).status).toBe(400);
    expect((await bulk(Array.from({ length: 201 }, () => ({ id: a.id })))).status).toBe(400);
  });
});
