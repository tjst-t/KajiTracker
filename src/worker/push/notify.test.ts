import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser, mockPushService } from "../../../test/push";
import worker from "../index";

const TODAY = "2026-10-07";
/** 日本時間の "HH:MM"（今日）を Date にする */
const at = (hhmm: string) => new Date(`${TODAY}T${hhmm}:00+09:00`);

/** Cron と同じに Worker の scheduled() を起こし、終わるまで待つ */
async function runCron(now: Date) {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ scheduledTime: now, cron: "*/15 * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

/** D1 に直接入れる。id はテストごとにかぶらないようにする */
async function setup() {
  const p = crypto.randomUUID().slice(0, 8);
  const run = (sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).run();
  const browsers = new Map<string, Awaited<ReturnType<typeof fakeBrowser>>>();

  async function user(name: string, notifyTime: string) {
    const id = `${p}-${name}`;
    await run("INSERT INTO users (id, display_name, webauthn_user_id, notify_time) VALUES (?, ?, ?, ?)", id, name, id, notifyTime);
    const b = await fakeBrowser();
    browsers.set(id, b);
    const s = b.subscription;
    await run(
      "INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, device_label) VALUES (?, ?, ?, ?, ?, 'テスト')",
      crypto.randomUUID(),
      id,
      s.endpoint,
      s.keys.p256dh,
      s.keys.auth,
    );
    return id;
  }
  async function family(name: string, members: string[]) {
    const id = `${p}-${name}`;
    await run("INSERT INTO families (id, name) VALUES (?, ?)", id, name);
    for (const u of members) await run("INSERT INTO family_members (family_id, user_id, role) VALUES (?, ?, 'member')", id, u);
    return id;
  }
  async function chore(familyId: string, name: string, o: { firstDueOn?: string; assignee?: string; notifyTime?: string; archived?: boolean } = {}) {
    const id = `${p}-${name}`;
    await run(
      "INSERT INTO chores (id, family_id, name, schedule_type, interval_days, first_due_on, assignee_user_id, notify_time, archived_at) VALUES (?, ?, ?, 'interval', 7, ?, ?, ?, ?)",
      id,
      familyId,
      name,
      o.firstDueOn ?? TODAY,
      o.assignee ?? null,
      o.notifyTime ?? null,
      o.archived ? new Date().toISOString() : null,
    );
    return id;
  }
  async function log(choreId: string, userId: string, doneOn: string) {
    await run("INSERT INTO logs (id, chore_id, family_id, user_id, done_on) SELECT ?, id, family_id, ?, ? FROM chores WHERE id = ?", crypto.randomUUID(), userId, doneOn, choreId);
  }

  /** この setup のユーザーに届いた通知（ユーザー id → 本文の一覧） */
  async function received(calls: { url: string; body: Uint8Array }[]) {
    const out: Record<string, unknown[]> = {};
    for (const [uid, b] of browsers) {
      for (const c of calls.filter((c) => c.url === b.subscription.endpoint)) (out[uid] ??= []).push(await b.decrypt(c.body));
    }
    return out;
  }
  const sentRows = (userId: string) =>
    env.DB.prepare("SELECT chore_id, due_on FROM notifications_sent WHERE user_id = ? ORDER BY chore_id")
      .bind(userId)
      .all<{ chore_id: string; due_on: string }>()
      .then((r) => r.results);

  return { user, family, chore, log, received, sentRows };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Cron で当日の家事を送る", () => {
  it("担当者に家事の時刻で、担当なしは全員に人の時刻で、1人1通にまとめて送る", async () => {
    const s = await setup();
    const a = await s.user("あ", "07:00");
    const b = await s.user("い", "21:00");
    const fam = await s.family("自宅", [a, b]);
    const gomi = await s.chore(fam, "ゴミ出し", { assignee: b, notifyTime: "07:00" });
    const sentaku = await s.chore(fam, "洗濯槽の掃除");
    const furo = await s.chore(fam, "風呂掃除", { assignee: a });
    await s.chore(fam, "遅れている", { firstDueOn: "2026-10-01" });
    await s.chore(fam, "しまった", { archived: true });
    const done = await s.chore(fam, "今日やった");
    await s.log(done, a, TODAY);

    // 07:00〜07:14：ゴミ出し（家事の時刻）は担当の い に、洗濯槽・風呂は あ（07:00）に1通で
    let calls = mockPushService(() => 201);
    await runCron(at("07:05"));
    expect(await s.received(calls)).toEqual({
      [a]: [{ title: "今日の家事", body: expect.toSatisfy((t: string) => t.split("・").sort().join() === ["洗濯槽の掃除", "風呂掃除"].sort().join()), url: "/" }],
      [b]: [{ title: "今日の家事", body: "ゴミ出し", url: "/" }],
    });
    expect(await s.sentRows(a)).toEqual([furo, sentaku].sort().map((chore_id) => ({ chore_id, due_on: TODAY })));
    expect(await s.sentRows(b)).toEqual([{ chore_id: gomi, due_on: TODAY }]);

    // 同じ時刻帯でもう一度動いても、二度は送らない
    vi.restoreAllMocks();
    calls = mockPushService(() => 201);
    await runCron(at("07:10"));
    expect(await s.received(calls)).toEqual({});

    // 07:15 はだれの時刻でもない
    await runCron(at("07:15"));
    expect(await s.received(calls)).toEqual({});

    // 21:00：い に洗濯槽の掃除（担当なし）。風呂掃除は担当の あ だけなので来ない
    await runCron(at("21:00"));
    expect(await s.received(calls)).toEqual({ [b]: [{ title: "今日の家事", body: "洗濯槽の掃除", url: "/" }] });
  });

  it("Family が複数ある人には Family 名をつける", async () => {
    const s = await setup();
    const a = await s.user("あ", "20:00");
    const home = await s.family("自宅", [a]);
    const parents = await s.family("実家", [a]);
    await s.chore(home, "ゴミ出し");
    await s.chore(parents, "草むしり");

    const calls = mockPushService(() => 201);
    await runCron(at("20:00"));
    const got = (await s.received(calls))[a] as { body: string }[];
    expect(got).toHaveLength(1);
    expect(got[0]!.body.split("／").sort()).toEqual(["実家：草むしり", "自宅：ゴミ出し"].sort());
  });

  it("日本時間の 0:00（UTC 15:00）には、日本の今日が期限の家事を送る", async () => {
    const s = await setup();
    const a = await s.user("あ", "00:00");
    const fam = await s.family("自宅", [a]);
    await s.chore(fam, "ゴミ出し");
    await s.chore(fam, "昨日まで", { firstDueOn: "2026-10-06" });

    const calls = mockPushService(() => 201);
    await runCron(new Date("2026-10-06T15:00:00Z"));
    expect(await s.received(calls)).toEqual({ [a]: [{ title: "今日の家事", body: "ゴミ出し", url: "/" }] });
  });
});
