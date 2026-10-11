import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { addDays, todayInTokyo } from "../../shared/date";
import { TestDevice, bootstrapUser } from "../../../test/client";

type Subtask = { id: string; todoId: string; title: string; done: boolean; doneAt: string | null; doneByName: string | null; sortOrder: number };
type Todo = {
  id: string;
  title: string;
  memo: string | null;
  hasMemo: boolean;
  dueOn: string | null;
  dueStatus: "overdue" | "today" | "upcoming" | null;
  daysLate: number;
  assigneeUserId: string | null;
  assigneeName: string | null;
  groupId: string | null;
  groupName: string | null;
  notifyTime: string | null;
  createdByName: string | null;
  done: boolean;
  doneAt: string | null;
  doneByName: string | null;
  sortOrder: number;
  subtasks: Subtask[];
  progress: { done: number; total: number };
};

const today = todayInTokyo();

async function setup() {
  const takumi = await bootstrapUser("たくみ");
  const fam = (await takumi.post("/api/families", { name: "辻下家" })).json;
  const inv = (await takumi.post(`/api/families/${fam.id}/invites`)).json;
  const wife = new TestDevice();
  await wife.registerViaInvite(inv.url.split("#invite=")[1], "はなこ");
  const add = (b: object, d: TestDevice = takumi) => d.post(`/api/families/${fam.id}/todos`, { title: "役所に電話", ...b });
  const list = async (q = "", d: TestDevice = takumi) => (await d.get(`/api/families/${fam.id}/todos${q}`)).json.todos as Todo[];
  const get = async (id: string, d: TestDevice = takumi) => (await d.get(`/api/todos/${id}`)).json as Todo;
  return { takumi, wife, fam, add, list, get };
}

describe("TODO", () => {
  it("登録・詳細・直す・消す。メモは家事のやり方と同じ決まり", async () => {
    const { takumi, wife, fam, add, get } = await setup();
    const groups = (await takumi.get(`/api/families/${fam.id}/groups`)).json as { id: string; name: string }[];
    const r = await add({
      title: " 車検の予約 ",
      memo: "## 手順\r\n- [ ] 電話する",
      dueOn: today,
      assigneeUserId: wife.userId,
      groupId: groups[0]!.id,
      notifyTime: "09:15",
      subtasks: ["見積もり", "日程を決める"],
    });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({
      title: "車検の予約",
      memo: "## 手順\n- [ ] 電話する",
      hasMemo: true,
      dueOn: today,
      dueStatus: "today",
      assigneeName: "はなこ",
      groupName: groups[0]!.name,
      notifyTime: "09:15",
      createdByName: "たくみ",
      done: false,
      progress: { done: 0, total: 2 },
    });
    expect((r.json as Todo).subtasks.map((s) => s.title)).toEqual(["見積もり", "日程を決める"]);

    const id = r.json.id as string;
    const p = await wife.patch(`/api/todos/${id}`, { title: "車検", memo: " ", dueOn: null, assigneeUserId: null, groupId: null, notifyTime: null });
    expect(p.status).toBe(200);
    expect(await get(id)).toMatchObject({ title: "車検", memo: null, hasMemo: false, dueOn: null, dueStatus: null, assigneeName: null, groupName: null, notifyTime: null });

    expect((await takumi.del(`/api/todos/${id}`)).status).toBe(200);
    expect((await takumi.get(`/api/todos/${id}`)).status).toBe(404);
  });

  it("入力の不備は 400", async () => {
    const { add } = await setup();
    const other = await bootstrapUser("よその人");
    expect((await add({ title: "" })).status).toBe(400);
    expect((await add({ title: "あ".repeat(61) })).status).toBe(400);
    expect((await add({ title: "あ".repeat(60) })).status).toBe(201);
    expect((await add({ memo: "あ".repeat(10001) })).status).toBe(400);
    expect((await add({ dueOn: "2026/10/11" })).status).toBe(400);
    expect((await add({ notifyTime: "09:10" })).status).toBe(400);
    expect((await add({ assigneeUserId: other.userId })).status).toBe(400);
    expect((await add({ groupId: "nope" })).status).toBe(400);
    expect((await add({ subtasks: [""] })).status).toBe(400);
    expect((await add({ subtasks: "見積もり" })).status).toBe(400);
  });

  it("よその Family の TODO・サブタスクは見えず、触れない（404）", async () => {
    const { fam, add } = await setup();
    const other = await bootstrapUser("よその人");
    const t = (await add({ subtasks: ["見積もり"] })).json as Todo;
    const sid = t.subtasks[0]!.id;
    expect((await other.get(`/api/families/${fam.id}/todos`)).status).toBe(404);
    expect((await other.post(`/api/families/${fam.id}/todos`, { title: "いたずら" })).status).toBe(404);
    expect((await other.get(`/api/todos/${t.id}`)).status).toBe(404);
    expect((await other.patch(`/api/todos/${t.id}`, { done: true })).status).toBe(404);
    expect((await other.del(`/api/todos/${t.id}`)).status).toBe(404);
    expect((await other.post(`/api/todos/${t.id}/subtasks`, { title: "いたずら" })).status).toBe(404);
    expect((await other.patch(`/api/subtasks/${sid}`, { done: true })).status).toBe(404);
    expect((await other.del(`/api/subtasks/${sid}`)).status).toBe(404);
    expect((await new TestDevice().get(`/api/todos/${t.id}`)).status).toBe(401);
  });

  it("済みにすると済ませた人と時刻を記録し、取り消せる。済んでも消えずに済みの一覧に残る", async () => {
    const { takumi, wife, add, list, get } = await setup();
    const t = (await add({ subtasks: ["見積もり"] })).json as Todo;
    const d = await wife.patch(`/api/todos/${t.id}`, { done: true });
    expect(d.status).toBe(200);
    expect(d.json).toMatchObject({ done: true, doneByName: "はなこ" });
    expect(d.json.doneAt).toEqual(expect.any(String));
    // 親を済みにしても、残ったサブタスクはそのまま
    expect(d.json.subtasks[0]).toMatchObject({ done: false });
    // もう一度 done: true を送っても、最初に済ませた人のまま
    const again = await takumi.patch(`/api/todos/${t.id}`, { done: true });
    expect(again.json).toMatchObject({ doneByName: "はなこ", doneAt: d.json.doneAt });

    expect((await list()).map((x) => x.id)).not.toContain(t.id);
    expect((await list("?status=done")).map((x) => x.id)).toEqual([t.id]);

    const u = await takumi.patch(`/api/todos/${t.id}`, { done: false });
    expect(u.json).toMatchObject({ done: false, doneAt: null, doneByName: null });
    expect((await list()).map((x) => x.id)).toEqual([t.id]);
    expect(await list("?status=done")).toEqual([]);
    expect((await takumi.patch(`/api/todos/${t.id}`, { done: "yes" })).status).toBe(400);
    expect((await get(t.id)).done).toBe(false);
  });

  it("未完了は期限の近い順・期限なしは後ろ。due=today-or-overdue で今日と遅れだけ。済みは新しい順", async () => {
    const { takumi, list, add } = await setup();
    const none1 = (await add({ title: "期限なし1" })).json.id;
    const later = (await add({ title: "来週", dueOn: addDays(today, 7) })).json.id;
    const late = (await add({ title: "おととい", dueOn: addDays(today, -2) })).json.id;
    const none2 = (await add({ title: "期限なし2" })).json.id;
    const now = (await add({ title: "今日", dueOn: today })).json.id;
    const all = await list("?status=open");
    expect(all.map((t) => t.title)).toEqual(["おととい", "今日", "来週", "期限なし1", "期限なし2"]);
    expect(all.map((t) => [t.dueStatus, t.daysLate])).toEqual([
      ["overdue", 2],
      ["today", 0],
      ["upcoming", 0],
      [null, 0],
      [null, 0],
    ]);
    expect((await list()).map((t) => t.id)).toEqual([late, now, later, none1, none2]);
    expect((await list("?due=today-or-overdue")).map((t) => t.id)).toEqual([late, now]);

    // 並び順を変えると、期限なしどうしの並びが変わる
    expect((await takumi.patch(`/api/todos/${none2}`, { sortOrder: -1 })).status).toBe(200);
    expect((await list()).map((t) => t.id)).toEqual([late, now, later, none2, none1]);
    expect((await takumi.patch(`/api/todos/${none2}`, { sortOrder: 1.5 })).status).toBe(400);

    await takumi.patch(`/api/todos/${now}`, { done: true });
    await takumi.patch(`/api/todos/${late}`, { done: true });
    expect((await list("?due=today-or-overdue")).map((t) => t.id)).toEqual([]);
    expect((await list("?status=done")).map((t) => t.id)).toEqual([late, now]);

  });

  it("status・due の値が違えば 400", async () => {
    const { takumi, fam } = await setup();
    expect((await takumi.get(`/api/families/${fam.id}/todos?status=all`)).status).toBe(400);
    expect((await takumi.get(`/api/families/${fam.id}/todos?due=tomorrow`)).status).toBe(400);
    expect((await takumi.get(`/api/families/${fam.id}/todos?status=done&due=today-or-overdue`)).status).toBe(400);
  });

  it("担当の人が Family を抜けたら、担当なしに戻る", async () => {
    const { wife, fam, add, get } = await setup();
    const t = (await add({ assigneeUserId: wife.userId })).json.id;
    expect((await wife.del(`/api/families/${fam.id}/members/${wife.userId}`)).status).toBe(200);
    expect(await get(t)).toMatchObject({ assigneeUserId: null, assigneeName: null });
  });
});

describe("サブタスク（1段）", () => {
  it("足す・題名を直す・済み／取り消し（済ませた人つき）・並べ替え・消す。全部済んでも親は済みにならない", async () => {
    const { takumi, wife, add, get } = await setup();
    const t = (await add({})).json as Todo;
    const a = await takumi.post(`/api/todos/${t.id}/subtasks`, { title: " 見積もり " });
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ todoId: t.id, title: "見積もり", done: false, sortOrder: 0 });
    const b = (await takumi.post(`/api/todos/${t.id}/subtasks`, { title: "日程" })).json as Subtask;
    expect(b.sortOrder).toBe(1);
    expect((await takumi.post(`/api/todos/${t.id}/subtasks`, { title: "" })).status).toBe(400);
    expect((await takumi.post(`/api/todos/${t.id}/subtasks`, { title: "あ".repeat(61) })).status).toBe(400);

    expect((await takumi.patch(`/api/subtasks/${b.id}`, { title: "日程を決める", sortOrder: -1 })).json).toMatchObject({ title: "日程を決める", sortOrder: -1 });
    expect((await get(t.id)).subtasks.map((s) => s.title)).toEqual(["日程を決める", "見積もり"]);

    const d = await wife.patch(`/api/subtasks/${a.json.id}`, { done: true });
    expect(d.json).toMatchObject({ done: true, doneByName: "はなこ" });
    expect((await get(t.id)).progress).toEqual({ done: 1, total: 2 });
    await takumi.patch(`/api/subtasks/${b.id}`, { done: true });
    const all = await get(t.id);
    expect(all.progress).toEqual({ done: 2, total: 2 });
    expect(all.done).toBe(false);

    expect((await takumi.patch(`/api/subtasks/${b.id}`, { done: false })).json).toMatchObject({ done: false, doneAt: null, doneByName: null });
    expect((await takumi.patch(`/api/subtasks/${b.id}`, { done: 1 })).status).toBe(400);

    expect((await takumi.del(`/api/subtasks/${b.id}`)).status).toBe(200);
    expect((await get(t.id)).subtasks.map((s) => s.id)).toEqual([a.json.id]);
    expect((await takumi.patch(`/api/subtasks/${b.id}`, { done: true })).status).toBe(404);
  });

  it("サブタスクのサブタスクは作れない", async () => {
    const { takumi, add, get } = await setup();
    const t = (await add({ subtasks: ["見積もり"] })).json as Todo;
    const sid = t.subtasks[0]!.id;
    expect((await takumi.post(`/api/todos/${sid}/subtasks`, { title: "孫" })).status).toBe(404);
    expect((await takumi.post(`/api/subtasks/${sid}/subtasks`, { title: "孫" })).status).toBe(404);
    // 親を指す項目を送っても、その TODO の下に1段で入るだけ
    const r = await takumi.post(`/api/todos/${t.id}/subtasks`, { title: "子", parentId: sid });
    expect(r.status).toBe(201);
    expect((await get(t.id)).subtasks.map((s) => s.title)).toEqual(["見積もり", "子"]);
  });

  it("TODO を消すとサブタスクも消える", async () => {
    const { takumi, add } = await setup();
    const t = (await add({ subtasks: ["見積もり", "日程"] })).json as Todo;
    expect((await takumi.del(`/api/todos/${t.id}`)).status).toBe(200);
    const n = await env.DB.prepare("SELECT count(*) AS n FROM todo_subtasks WHERE todo_id = ?").bind(t.id).first<{ n: number }>();
    expect(n?.n).toBe(0);
    expect((await takumi.patch(`/api/subtasks/${t.subtasks[0]!.id}`, { done: true })).status).toBe(404);
  });
});

describe("統計", () => {
  it("TODO を済ませても、分担の数には入らない", async () => {
    const { takumi, fam, add } = await setup();
    const t = (await add({})).json.id;
    await takumi.patch(`/api/todos/${t}`, { done: true });
    const s = (await takumi.get(`/api/families/${fam.id}/stats`)).json;
    expect(s.totalCount).toBe(0);
  });
});
