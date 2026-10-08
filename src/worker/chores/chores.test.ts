import { describe, expect, it } from "vitest";
import { addDays, todayInTokyo, toDayNum, weekdayOf } from "../../shared/date";
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

const interval = (intervalDays: number, firstDueOn: string) => ({ type: "interval", intervalDays, firstDueOn });

describe("家事の登録", () => {
  it("前回からの日数：登録した家事が一覧に、期限と状態つきで出る", async () => {
    const { takumi, wife, fam } = await family();
    const r = await takumi.post(`/api/families/${fam.id}/chores`, {
      name: "ゴミ出し",
      schedule: interval(7, addDays(today(), -2)),
      assigneeUserId: wife.userId,
      notifyTime: "07:00",
    });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: "ゴミ出し", assigneeName: "はなこ", notifyTime: "07:00", status: "overdue", daysLate: 2, lastLog: null });

    const list = (await wife.get(`/api/families/${fam.id}/chores`)).json;
    expect(list.today).toBe(today());
    expect(list.chores).toHaveLength(1);
    expect(list.chores[0]).toMatchObject({ name: "ゴミ出し", dueOn: addDays(today(), -2), status: "overdue" });
  });

  it("カレンダー固定（毎週）：基準日は登録した日になる", async () => {
    const { takumi, fam } = await family();
    const wd = weekdayOf(toDayNum(today()));
    const r = await takumi.post(`/api/families/${fam.id}/chores`, { name: "シーツ交換", schedule: { type: "calendar", rule: { kind: "weekly", weekdays: [wd] } } });
    expect(r.status).toBe(201);
    expect(r.json.schedule.rule).toMatchObject({ kind: "weekly", weekdays: [wd], every: 1, anchor: today() });
    expect(r.json).toMatchObject({ dueOn: today(), status: "today" });
  });

  it("隔週・数か月ごとは最初の予定日が要り、選んだ曜日に当たる日でなければ断る", async () => {
    const { takumi, fam } = await family();
    const wd = weekdayOf(toDayNum(today()));
    const noAnchor = await takumi.post(`/api/families/${fam.id}/chores`, { name: "換気扇", schedule: { type: "calendar", rule: { kind: "weekly", weekdays: [wd], every: 2 } } });
    expect(noAnchor.json.code).toBe("anchor_required");
    const wrong = await takumi.post(`/api/families/${fam.id}/chores`, {
      name: "換気扇",
      schedule: { type: "calendar", rule: { kind: "weekly", weekdays: [wd], every: 2, anchor: addDays(today(), 1) } },
    });
    expect(wrong.json.code).toBe("anchor_not_occurrence");
    const ok = await takumi.post(`/api/families/${fam.id}/chores`, {
      name: "換気扇",
      schedule: { type: "calendar", rule: { kind: "weekly", weekdays: [wd], every: 2, anchor: addDays(today(), 7) } },
    });
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ dueOn: addDays(today(), 7), status: "upcoming" });
  });

  it("おかしな入力は断る", async () => {
    const { takumi, fam } = await family();
    const post = (b: object) => takumi.post(`/api/families/${fam.id}/chores`, { name: "x", schedule: interval(7, today()), ...b });
    expect((await post({ name: "" })).status).toBe(400);
    expect((await post({ schedule: interval(0, today()) })).status).toBe(400);
    expect((await post({ schedule: interval(7, "2026/10/01") })).status).toBe(400);
    expect((await post({ schedule: { type: "calendar", rule: { kind: "weekly", weekdays: [] } } })).status).toBe(400);
    expect((await post({ notifyTime: "07:10" })).status).toBe(400);
    const stranger = await bootstrapUser("他人");
    expect((await post({ assigneeUserId: stranger.userId })).status).toBe(400);
  });

  it("よその Family の家事は見えず、触れない", async () => {
    const { takumi, fam } = await family();
    const chore = (await takumi.post(`/api/families/${fam.id}/chores`, { name: "ゴミ出し", schedule: interval(7, today()) })).json;
    const stranger = await bootstrapUser("他人");
    expect((await stranger.get(`/api/families/${fam.id}/chores`)).status).toBe(404);
    expect((await stranger.get(`/api/chores/${chore.id}`)).status).toBe(404);
    expect((await stranger.post(`/api/chores/${chore.id}/logs`)).status).toBe(404);
    expect((await stranger.patch(`/api/chores/${chore.id}`, { name: "x" })).status).toBe(404);
    expect((await new TestDevice().get(`/api/chores/${chore.id}`)).status).toBe(401);
  });
});

describe("記録", () => {
  it("ワンタップ（日付なし）で今日の記録になり、次の期限が進む。やった人はログインしている人", async () => {
    const { takumi, wife, fam } = await family();
    const chore = (await takumi.post(`/api/families/${fam.id}/chores`, { name: "ゴミ出し", schedule: interval(7, addDays(today(), -3)) })).json;
    const r = await wife.post(`/api/chores/${chore.id}/logs`);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ log: { doneOn: today(), userName: "はなこ" }, dueOn: addDays(today(), 7), status: "upcoming" });

    const detail = (await takumi.get(`/api/chores/${chore.id}`)).json;
    expect(detail.lastLog).toMatchObject({ doneOn: today(), userName: "はなこ" });
    expect(detail.cycles).toEqual([{ dueOn: addDays(today(), -3), doneOn: today(), daysLate: 3, missed: false }]);
  });

  it("さかのぼって記録でき、期限の計算に入る。先の日付は断る", async () => {
    const { takumi, fam } = await family();
    const chore = (await takumi.post(`/api/families/${fam.id}/chores`, { name: "風呂掃除", schedule: interval(3, addDays(today(), -5)) })).json;
    const r = await takumi.post(`/api/chores/${chore.id}/logs`, { doneOn: addDays(today(), -2) });
    expect(r.json).toMatchObject({ dueOn: addDays(today(), 1), status: "upcoming" });
    expect((await takumi.post(`/api/chores/${chore.id}/logs`, { doneOn: addDays(today(), 1) })).status).toBe(400);
  });

  it("取り消すと期限が元に戻り、記録の一覧から消える（家族のだれでも取り消せる）", async () => {
    const { takumi, wife, fam } = await family();
    const chore = (await takumi.post(`/api/families/${fam.id}/chores`, { name: "ゴミ出し", schedule: interval(7, addDays(today(), -1)) })).json;
    const log = (await takumi.post(`/api/chores/${chore.id}/logs`)).json.log;
    expect((await wife.del(`/api/logs/${log.id}`)).status).toBe(200);
    const detail = (await takumi.get(`/api/chores/${chore.id}`)).json;
    expect(detail).toMatchObject({ dueOn: addDays(today(), -1), status: "overdue", daysLate: 1, lastLog: null, logs: [] });
    expect((await takumi.del(`/api/logs/${log.id}`)).status).toBe(404);
  });

  it("家事の統計：守れた率・平均の遅れ・実際の平均間隔", async () => {
    const { takumi, fam } = await family();
    const t = today();
    const chore = (await takumi.post(`/api/families/${fam.id}/chores`, { name: "排水口", schedule: interval(7, addDays(t, -30)) })).json;
    // 期限 -30 に -30（守れた）、期限 -23 に -20（3日遅れ）、期限 -13 に -13（守れた）
    for (const d of [-30, -20, -13]) await takumi.post(`/api/chores/${chore.id}/logs`, { doneOn: addDays(t, d) });
    const stats = (await takumi.get(`/api/chores/${chore.id}`)).json.stats;
    expect(stats).toEqual({ doneCount: 3, onTimeRate: 67, averageDaysLate: 1, missedCount: 0, averageInterval: 8.5, plannedInterval: 7 });
  });
});

describe("編集・無効にする・消す", () => {
  it("名前・周期・担当・通知の時刻を変えられる。担当を外すと null", async () => {
    const { takumi, wife, fam } = await family();
    const chore = (await takumi.post(`/api/families/${fam.id}/chores`, { name: "ゴミ出し", schedule: interval(7, today()), assigneeUserId: wife.userId })).json;
    expect(
      (await takumi.patch(`/api/chores/${chore.id}`, { name: "燃えるゴミ", schedule: interval(3, addDays(today(), 1)), assigneeUserId: null, notifyTime: "06:45" })).status,
    ).toBe(200);
    expect((await takumi.get(`/api/chores/${chore.id}`)).json).toMatchObject({
      name: "燃えるゴミ",
      schedule: { type: "interval", intervalDays: 3 },
      assigneeUserId: null,
      notifyTime: "06:45",
      dueOn: addDays(today(), 1),
    });
  });

  it("無効の家事は一覧から外れ（archived=1 で出る）、戻せる", async () => {
    const { takumi, fam } = await family();
    const chore = (await takumi.post(`/api/families/${fam.id}/chores`, { name: "こたつ布団", schedule: interval(180, today()) })).json;
    await takumi.patch(`/api/chores/${chore.id}`, { archived: true });
    expect((await takumi.get(`/api/families/${fam.id}/chores`)).json.chores).toHaveLength(0);
    expect((await takumi.get(`/api/families/${fam.id}/chores?archived=1`)).json.chores[0]).toMatchObject({ archived: true });
    await takumi.patch(`/api/chores/${chore.id}`, { archived: false });
    expect((await takumi.get(`/api/families/${fam.id}/chores`)).json.chores).toHaveLength(1);
  });

  it("消すと記録ごと消える", async () => {
    const { takumi, fam } = await family();
    const chore = (await takumi.post(`/api/families/${fam.id}/chores`, { name: "x", schedule: interval(7, today()) })).json;
    await takumi.post(`/api/chores/${chore.id}/logs`);
    expect((await takumi.del(`/api/chores/${chore.id}`)).status).toBe(200);
    expect((await takumi.get(`/api/chores/${chore.id}`)).status).toBe(404);
  });
});
