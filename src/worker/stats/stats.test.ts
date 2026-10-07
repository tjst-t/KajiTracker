import { describe, expect, it } from "vitest";
import { addDays, todayInTokyo, toDayNum, weekdayOf } from "../../shared/date";
import { monthRange } from "../../shared/stats";
import { TestDevice, bootstrapUser } from "../../../test/client";

const today = () => todayInTokyo();

async function family() {
  const takumi = await bootstrapUser("たくみ");
  const fam = (await takumi.post("/api/families", { name: "辻下家" })).json;
  const inv = (await takumi.post(`/api/families/${fam.id}/invites`)).json;
  const wife = new TestDevice();
  await wife.registerViaInvite(inv.url.split("#invite=")[1], "はなこ");
  return { takumi, wife, fam };
}

describe("統計の API", () => {
  it("分担・偏り・守り具合・推移・ランキングを返す。取り消しは外し、抜けた人も名前で出る", async () => {
    const { takumi, wife, fam } = await family();
    const t = today();
    const d = (n: number) => addDays(t, n);
    // 3日ごと。期限 t-20（その日に済）→ t-17（t-16 に済、1日遅れ）→ t-13（その日に済）→ t-10 は開いている
    const bath = (await takumi.post(`/api/families/${fam.id}/chores`, { name: "風呂掃除", schedule: { type: "interval", intervalDays: 3, firstDueOn: d(-20) } })).json;
    // 一度も記録の無い家事（期限 t-30 から開いたまま）
    await takumi.post(`/api/families/${fam.id}/chores`, { name: "換気扇", schedule: { type: "interval", intervalDays: 30, firstDueOn: d(-30) } });
    expect((await takumi.post(`/api/chores/${bath.id}/logs`, { doneOn: d(-20) })).status).toBe(201);
    await wife.post(`/api/chores/${bath.id}/logs`, { doneOn: d(-16) });
    await takumi.post(`/api/chores/${bath.id}/logs`, { doneOn: d(-13) });
    const undone = (await wife.post(`/api/chores/${bath.id}/logs`, { doneOn: d(-12) })).json;
    expect((await wife.del(`/api/logs/${undone.log.id}`)).status).toBe(200);
    // はなこは抜ける（記録は残る）
    expect((await wife.del(`/api/families/${fam.id}/members/${wife.userId}`)).status).toBe(200);

    const r = await takumi.get(`/api/families/${fam.id}/stats?from=${d(-20)}&to=${t}`);
    expect(r.status).toBe(200);
    const s = r.json;
    expect(s).toMatchObject({ today: t, from: d(-20), to: t, totalCount: 3 });
    expect(s.people).toEqual([
      { userId: takumi.userId, name: "たくみ", isMember: true, count: 2, share: 67 },
      { userId: wife.userId, name: "はなこ", isMember: false, count: 1, share: 33 },
    ]);
    expect(s.byChore).toEqual([
      {
        choreId: bath.id,
        name: "風呂掃除",
        archived: false,
        count: 3,
        byUser: [
          { userId: takumi.userId, count: 2 },
          { userId: wife.userId, count: 1 },
        ],
      },
    ]);
    // 3回のうち期限内 2回（67%）、平均の遅れ 1 ÷ 3 ＝ 0.3
    expect(s.punctuality).toEqual({ judgedCount: 3, onTimeCount: 2, onTimeRate: 67, averageDaysLate: 0.3, missedCount: 0 });
    expect(s.lateRanking).toEqual([
      { choreId: bath.id, name: "風呂掃除", archived: false, score: 0.3, judgedCount: 3, onTimeCount: 2, onTimeRate: 67, averageDaysLate: 0.3, missedCount: 0 },
    ]);
    // 週は月曜始まりで、期間をすき間なく覆う
    const weeks: { weekStart: string; count: number }[] = s.weekly;
    expect(weeks.every((w) => weekdayOf(toDayNum(w.weekStart)) === 1)).toBe(true);
    expect(weeks[0]!.weekStart <= d(-20) && d(-20) < addDays(weeks[0]!.weekStart, 7)).toBe(true);
    expect(weeks.at(-1)!.weekStart <= t && t < addDays(weeks.at(-1)!.weekStart, 7)).toBe(true);
    expect(weeks.reduce((a, w) => a + w.count, 0)).toBe(3);
    expect(s.monthly.reduce((a: number, m: { count: number }) => a + m.count, 0)).toBe(3);
  });

  it("しまった家事の記録も数える", async () => {
    const { takumi, fam } = await family();
    const chore = (await takumi.post(`/api/families/${fam.id}/chores`, { name: "網戸", schedule: { type: "interval", intervalDays: 90, firstDueOn: addDays(today(), -5) } })).json;
    await takumi.post(`/api/chores/${chore.id}/logs`, { doneOn: addDays(today(), -2) });
    await takumi.patch(`/api/chores/${chore.id}`, { archived: true });
    const s = (await takumi.get(`/api/families/${fam.id}/stats?from=${addDays(today(), -10)}&to=${today()}`)).json;
    expect(s.byChore).toMatchObject([{ name: "網戸", archived: true, count: 1 }]);
    expect(s.lateRanking).toMatchObject([{ name: "網戸", averageDaysLate: 3, score: 3 }]);
  });

  it("期間を省けば今月", async () => {
    const { takumi, fam } = await family();
    const r = await takumi.get(`/api/families/${fam.id}/stats`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ...monthRange(today()), totalCount: 0, lateRanking: [] });
    expect(r.json.people).toHaveLength(2);
  });

  it("おかしな期間は断り、メンバーでなければ 404", async () => {
    const { takumi, fam } = await family();
    expect((await takumi.get(`/api/families/${fam.id}/stats?from=2026/10/01`)).status).toBe(400);
    expect((await takumi.get(`/api/families/${fam.id}/stats?from=2026-10-10&to=2026-10-01`)).status).toBe(400);
    const stranger = await bootstrapUser("他人");
    const r = await stranger.get(`/api/families/${fam.id}/stats`);
    expect(r.status).toBe(404);
    expect(r.json.code).toBe("family_not_found");
  });
});
