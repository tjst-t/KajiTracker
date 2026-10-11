import { describe, expect, it } from "vitest";
import { type PlanInput, planNotifications, slotStartInTokyo } from "./plan";

/** 日本時間の "YYYY-MM-DDTHH:MM" を Date にする */
const jst = (s: string) => new Date(`${s}:00+09:00`);

const TODAY = "2026-10-07";

type ChoreIn = Partial<PlanInput["chores"][number]> & { id: string };
type TodoIn = Partial<PlanInput["todos"][number]> & { id: string };

/** TODO は、指定が無ければ「今日が期限・担当なし・時刻なし・未完了」 */
function todo(t: TodoIn): PlanInput["todos"][number] {
  return { familyId: "f1", title: t.id, dueOn: TODAY, assigneeUserId: null, notifyTime: null, done: false, ...t };
}

/** 家事は、指定が無ければ「今日が期限・担当なし・時刻なし」 */
function chore(c: ChoreIn): PlanInput["chores"][number] {
  return {
    familyId: "f1",
    name: c.id,
    schedule: { type: "interval", intervalDays: 7, firstDueOn: TODAY },
    assigneeUserId: null,
    notifyTime: null,
    archived: false,
    doneOns: [],
    ...c,
  };
}

/** Family f1（自宅）に a（20:00）と b（07:00） */
function input(chores: ChoreIn[], over: Partial<PlanInput> = {}): PlanInput {
  return {
    families: [{ id: "f1", name: "自宅" }],
    members: [
      { familyId: "f1", userId: "a", notifyTime: "20:00" },
      { familyId: "f1", userId: "b", notifyTime: "07:00" },
    ],
    chores: chores.map(chore),
    todos: [],
    sent: [],
    sentTodos: [],
    ...over,
  };
}

/** だれに、どの家事を送るか（並びに左右されないように） */
const who = (plan: ReturnType<typeof planNotifications>) =>
  Object.fromEntries(plan.map((n) => [n.userId, n.items.map((i) => i.choreId)]));

describe("いまの時刻帯", () => {
  it("日本時間の15分きざみで切り下げる", () => {
    expect(slotStartInTokyo(jst(`${TODAY}T07:00`))).toBe(7 * 60);
    expect(slotStartInTokyo(jst(`${TODAY}T07:14`))).toBe(7 * 60);
    expect(slotStartInTokyo(jst(`${TODAY}T07:15`))).toBe(7 * 60 + 15);
    expect(slotStartInTokyo(new Date("2026-10-07T15:00:00Z"))).toBe(0); // 日本時間の 0:00
  });
});

describe("planNotifications", () => {
  it("担当なしなら Family 全員に、それぞれの人の時刻で送る", () => {
    const i = input([{ id: "ゴミ出し" }]);
    expect(who(planNotifications(i, jst(`${TODAY}T07:00`)))).toEqual({ b: ["ゴミ出し"] });
    expect(who(planNotifications(i, jst(`${TODAY}T20:00`)))).toEqual({ a: ["ゴミ出し"] });
    expect(who(planNotifications(i, jst(`${TODAY}T12:00`)))).toEqual({});
  });

  it("担当がいれば担当者だけに送る", () => {
    const i = input([{ id: "ゴミ出し", assigneeUserId: "a" }]);
    expect(who(planNotifications(i, jst(`${TODAY}T20:00`)))).toEqual({ a: ["ゴミ出し"] });
    expect(who(planNotifications(i, jst(`${TODAY}T07:00`)))).toEqual({});
  });

  it("担当者がもう Family にいなければ、担当なしと同じに全員へ", () => {
    const i = input([{ id: "ゴミ出し", assigneeUserId: "抜けた人" }]);
    expect(who(planNotifications(i, jst(`${TODAY}T07:00`)))).toEqual({ b: ["ゴミ出し"] });
  });

  it("家事の時刻があれば、人の時刻より優先する", () => {
    const i = input([{ id: "ゴミ出し", notifyTime: "06:30" }]);
    expect(who(planNotifications(i, jst(`${TODAY}T06:30`)))).toEqual({ a: ["ゴミ出し"], b: ["ゴミ出し"] });
    expect(who(planNotifications(i, jst(`${TODAY}T07:00`)))).toEqual({});
    expect(who(planNotifications(i, jst(`${TODAY}T20:00`)))).toEqual({});
  });

  it("07:00 の家事は 07:00〜07:14 の実行で送り、06:59・07:15 では送らない", () => {
    const i = input([{ id: "ゴミ出し", notifyTime: "07:00", assigneeUserId: "a" }]);
    for (const t of ["07:00", "07:07", "07:14"]) expect(who(planNotifications(i, jst(`${TODAY}T${t}`)))).toEqual({ a: ["ゴミ出し"] });
    for (const t of ["06:59", "07:15"]) expect(who(planNotifications(i, jst(`${TODAY}T${t}`)))).toEqual({});
  });

  it("日付は日本時間で変わる（UTC 15:00 が日本の 0:00）", () => {
    const i = input([{ id: "ゴミ出し", notifyTime: "00:00", assigneeUserId: "a" }]);
    // UTC では 10/6 の 15:00 だが、日本では 10/7 の 0:00。期限 10/7 の家事を送る
    const plan = planNotifications(i, new Date("2026-10-06T15:00:00Z"));
    expect(who(plan)).toEqual({ a: ["ゴミ出し"] });
    expect(plan[0]!.items).toEqual([{ choreId: "ゴミ出し", dueOn: TODAY }]);
    // その15分前は日本で 10/6 の 23:45。期限 10/7 はまだ先
    const before = input([{ id: "ゴミ出し", notifyTime: "23:45", assigneeUserId: "a" }]);
    expect(who(planNotifications(before, new Date("2026-10-06T14:45:00Z")))).toEqual({});
  });

  it("同じ時刻帯の家事は1人1通にまとめる", () => {
    const i = input([{ id: "ゴミ出し" }, { id: "洗濯槽の掃除" }, { id: "朝の家事", notifyTime: "07:00", assigneeUserId: "a" }]);
    const plan = planNotifications(i, jst(`${TODAY}T07:00`));
    expect(plan).toHaveLength(2);
    const a = plan.find((n) => n.userId === "a")!;
    const b = plan.find((n) => n.userId === "b")!;
    expect(a.payload).toEqual({ title: "今日の家事", body: "朝の家事", url: "/" });
    expect(b.payload).toEqual({ title: "今日の家事", body: "ゴミ出し・洗濯槽の掃除", url: "/" });
    expect(b.items).toEqual([
      { choreId: "ゴミ出し", dueOn: TODAY },
      { choreId: "洗濯槽の掃除", dueOn: TODAY },
    ]);
  });

  it("Family が複数ある人には Family 名をつける", () => {
    const i = input([{ id: "ゴミ出し" }, { id: "洗濯" }, { id: "草むしり", familyId: "f2" }], {
      families: [
        { id: "f1", name: "自宅" },
        { id: "f2", name: "実家" },
      ],
      members: [
        { familyId: "f1", userId: "a", notifyTime: "20:00" },
        { familyId: "f2", userId: "a", notifyTime: "20:00" },
        { familyId: "f1", userId: "b", notifyTime: "20:00" },
      ],
    });
    const plan = planNotifications(i, jst(`${TODAY}T20:00`));
    expect(plan.find((n) => n.userId === "a")!.payload.body).toBe("自宅：ゴミ出し・洗濯／実家：草むしり");
    // b は Family が1つなので名前をつけない
    expect(plan.find((n) => n.userId === "b")!.payload.body).toBe("ゴミ出し・洗濯");
  });

  it("送った家事は送らない（同じ期限のものだけ）", () => {
    const i = input([{ id: "ゴミ出し" }, { id: "洗濯" }], {
      sent: [
        { userId: "a", choreId: "ゴミ出し", dueOn: TODAY },
        { userId: "a", choreId: "洗濯", dueOn: "2026-09-30" }, // 前の期限の分
      ],
    });
    expect(who(planNotifications(i, jst(`${TODAY}T20:00`)))).toEqual({ a: ["洗濯"] });
  });

  it("遅れている・まだ先・今日やった・無効の家事は送らない", () => {
    const i = input([
      { id: "遅れ", schedule: { type: "interval", intervalDays: 7, firstDueOn: "2026-10-06" } },
      { id: "まだ先", schedule: { type: "interval", intervalDays: 7, firstDueOn: "2026-10-08" } },
      { id: "今日やった", doneOns: [TODAY] },
      { id: "無効", archived: true },
      { id: "前回から7日", schedule: { type: "interval", intervalDays: 7, firstDueOn: "2026-09-01" }, doneOns: ["2026-09-30"] },
    ]);
    expect(who(planNotifications(i, jst(`${TODAY}T20:00`)))).toEqual({ a: ["前回から7日"] });
  });

  it("カレンダー固定の家事も、予定日の当日に送る", () => {
    // 2026-10-07 は水曜
    const weekly = (weekdays: number[]) => ({ type: "calendar" as const, rule: { kind: "weekly" as const, weekdays, every: 1, anchor: "2026-09-01" } });
    const i = input([
      { id: "水曜", schedule: weekly([3]) },
      { id: "木曜", schedule: weekly([4]) },
    ]);
    expect(who(planNotifications(i, jst(`${TODAY}T20:00`)))).toEqual({ a: ["水曜"] });
  });

  it("家事が無ければ何も送らない", () => {
    expect(planNotifications(input([]), jst(`${TODAY}T20:00`))).toEqual([]);
  });
});

/** だれに、どの TODO を送るか */
const whoTodo = (plan: ReturnType<typeof planNotifications>) =>
  Object.fromEntries(plan.filter((n) => n.todoItems.length).map((n) => [n.userId, n.todoItems.map((i) => i.todoId)]));

describe("planNotifications（TODO）", () => {
  it("期限が今日の TODO は、担当なしなら全員にそれぞれの時刻で、担当がいれば担当者だけに送る", () => {
    const i = input([], { todos: [todo({ id: "役所に電話" }), todo({ id: "車検の予約", assigneeUserId: "a" })] });
    const morning = planNotifications(i, jst(`${TODAY}T07:00`));
    expect(whoTodo(morning)).toEqual({ b: ["役所に電話"] });
    expect(morning[0]!.payload).toEqual({ title: "今日の TODO", body: "役所に電話", url: "/" });
    expect(morning[0]!.items).toEqual([]);
    expect(morning[0]!.todoItems).toEqual([{ todoId: "役所に電話", dueOn: TODAY }]);
    expect(whoTodo(planNotifications(i, jst(`${TODAY}T20:00`)))).toEqual({ a: ["役所に電話", "車検の予約"] });
    expect(whoTodo(planNotifications(i, jst(`${TODAY}T12:00`)))).toEqual({});
  });

  it("担当者がもう Family にいなければ、全員へ", () => {
    const i = input([], { todos: [todo({ id: "役所に電話", assigneeUserId: "抜けた人" })] });
    expect(whoTodo(planNotifications(i, jst(`${TODAY}T07:00`)))).toEqual({ b: ["役所に電話"] });
  });

  it("TODO の時刻があれば、人の時刻より優先する（15分の時刻帯で）", () => {
    const i = input([], { todos: [todo({ id: "役所に電話", notifyTime: "09:15" })] });
    for (const t of ["09:15", "09:29"]) expect(whoTodo(planNotifications(i, jst(`${TODAY}T${t}`)))).toEqual({ a: ["役所に電話"], b: ["役所に電話"] });
    for (const t of ["09:14", "09:30", "07:00", "20:00"]) expect(whoTodo(planNotifications(i, jst(`${TODAY}T${t}`)))).toEqual({});
  });

  it("同じ時刻帯の家事と TODO は1人1通にまとめる", () => {
    const i = input([{ id: "ゴミ出し" }, { id: "洗濯" }], { todos: [todo({ id: "役所に電話" }), todo({ id: "牛乳の解約" })] });
    const plan = planNotifications(i, jst(`${TODAY}T20:00`));
    expect(plan).toHaveLength(1);
    expect(plan[0]).toEqual({
      userId: "a",
      payload: { title: "今日の家事", body: "今日の家事：ゴミ出し・洗濯／TODO：役所に電話・牛乳の解約", url: "/" },
      items: [
        { choreId: "ゴミ出し", dueOn: TODAY },
        { choreId: "洗濯", dueOn: TODAY },
      ],
      todoItems: [
        { todoId: "役所に電話", dueOn: TODAY },
        { todoId: "牛乳の解約", dueOn: TODAY },
      ],
    });
  });

  it("家事と TODO で時刻帯が違えば、それぞれの時刻に送る", () => {
    const i = input([{ id: "ゴミ出し", assigneeUserId: "a" }], { todos: [todo({ id: "役所に電話", assigneeUserId: "a", notifyTime: "09:00" })] });
    expect(planNotifications(i, jst(`${TODAY}T09:00`)).map((n) => n.payload.body)).toEqual(["役所に電話"]);
    expect(planNotifications(i, jst(`${TODAY}T20:00`)).map((n) => n.payload.body)).toEqual(["ゴミ出し"]);
  });

  it("Family が複数ある人にまとめるときは、Family の区切りを「、」にする", () => {
    const i = input([{ id: "ゴミ出し" }, { id: "草むしり", familyId: "f2" }], {
      families: [
        { id: "f1", name: "自宅" },
        { id: "f2", name: "実家" },
      ],
      members: [
        { familyId: "f1", userId: "a", notifyTime: "20:00" },
        { familyId: "f2", userId: "a", notifyTime: "20:00" },
      ],
      todos: [todo({ id: "役所に電話" })],
    });
    expect(planNotifications(i, jst(`${TODAY}T20:00`))[0]!.payload.body).toBe("今日の家事：自宅：ゴミ出し、実家：草むしり／TODO：自宅：役所に電話");
  });

  it("送った TODO は送らない（同じ期限のものだけ）。家事の送った記録とは別", () => {
    const i = input([], {
      todos: [todo({ id: "役所に電話" }), todo({ id: "車検の予約" })],
      sentTodos: [
        { userId: "a", todoId: "役所に電話", dueOn: TODAY },
        { userId: "a", todoId: "車検の予約", dueOn: "2026-10-01" }, // 期限を変える前の分
      ],
      sent: [{ userId: "a", choreId: "車検の予約", dueOn: TODAY }], // 家事の id とかぶっても関係ない
    });
    expect(whoTodo(planNotifications(i, jst(`${TODAY}T20:00`)))).toEqual({ a: ["車検の予約"] });
  });

  it("遅れている・まだ先・期限なし・済みの TODO は送らない", () => {
    const i = input([], {
      todos: [
        todo({ id: "遅れ", dueOn: "2026-10-06" }),
        todo({ id: "まだ先", dueOn: "2026-10-08" }),
        todo({ id: "期限なし", dueOn: null }),
        todo({ id: "済み", done: true }),
        todo({ id: "今日" }),
      ],
    });
    expect(whoTodo(planNotifications(i, jst(`${TODAY}T20:00`)))).toEqual({ a: ["今日"] });
  });

  it("日付は日本時間で変わる（UTC 15:00 が日本の 0:00）", () => {
    const i = input([], { todos: [todo({ id: "役所に電話", notifyTime: "00:00", assigneeUserId: "a" })] });
    expect(whoTodo(planNotifications(i, new Date("2026-10-06T15:00:00Z")))).toEqual({ a: ["役所に電話"] });
    expect(whoTodo(planNotifications(i, new Date("2026-10-06T14:45:00Z")))).toEqual({});
  });
});
