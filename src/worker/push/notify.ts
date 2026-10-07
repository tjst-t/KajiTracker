// 当日の通知（Cron から呼ぶ）。DB から読み、plan.ts で決め、送って notifications_sent に入れる。
import { eq, isNull } from "drizzle-orm";
import { getDb } from "../db";
import { chores, families, familyMembers, logs, notificationsSent, users } from "../db/schema";
import { scheduleOf } from "../chores/routes";
import { todayInTokyo } from "../../shared/date";
import { type PlanInput, planNotifications } from "./plan";
import { sendPushToUser } from "./send";

export async function loadPlanInput(env: Env, now: Date): Promise<PlanInput> {
  const db = getDb(env.DB);
  const today = todayInTokyo(now);
  // 並びは登録順（まとめた本文の順になる）
  const choreRows = await db.select().from(chores).where(isNull(chores.archivedAt)).orderBy(chores.createdAt, chores.id).all();
  const familyIds = [...new Set(choreRows.map((c) => c.familyId))];
  if (familyIds.length === 0) return { families: [], members: [], chores: [], sent: [] };

  const [familyRows, memberRows, logRows, sentRows] = await Promise.all([
    db.select({ id: families.id, name: families.name }).from(families).all(),
    db
      .select({ familyId: familyMembers.familyId, userId: familyMembers.userId, notifyTime: users.notifyTime })
      .from(familyMembers)
      .innerJoin(users, eq(familyMembers.userId, users.id))
      .all(),
    db.select({ choreId: logs.choreId, doneOn: logs.doneOn }).from(logs).where(isNull(logs.deletedAt)).all(),
    db.select({ userId: notificationsSent.userId, choreId: notificationsSent.choreId, dueOn: notificationsSent.dueOn })
      .from(notificationsSent)
      .where(eq(notificationsSent.dueOn, today))
      .all(),
  ]);

  const doneOns = new Map<string, string[]>();
  for (const l of logRows) doneOns.set(l.choreId, [...(doneOns.get(l.choreId) ?? []), l.doneOn]);

  const planChores: PlanInput["chores"] = [];
  for (const c of choreRows) {
    let schedule;
    try {
      schedule = scheduleOf(c);
    } catch (e) {
      console.warn(`schedule broken: ${c.id}`, e);
      continue;
    }
    planChores.push({
      id: c.id,
      familyId: c.familyId,
      name: c.name,
      schedule,
      assigneeUserId: c.assigneeUserId,
      notifyTime: c.notifyTime,
      archived: !!c.archivedAt,
      doneOns: doneOns.get(c.id) ?? [],
    });
  }
  return { families: familyRows, members: memberRows, chores: planChores, sent: sentRows };
}

/**
 * いまの時刻帯の通知を送る。送る前に notifications_sent に入れ、入れられた分だけ送る
 * （Cron が重なって2回動いても二度は送らない）。送った通の数を返す
 */
export async function sendDueNotifications(env: Env, now: Date = new Date()): Promise<number> {
  const db = getDb(env.DB);
  const plan = planNotifications(await loadPlanInput(env, now), now);
  let count = 0;
  for (const n of plan) {
    const claimed = await db
      .insert(notificationsSent)
      .values(n.items.map((i) => ({ userId: n.userId, ...i })))
      .onConflictDoNothing()
      .returning({ choreId: notificationsSent.choreId })
      .all();
    if (claimed.length === 0) continue;
    // 一部だけ先に入っていた（重なった実行と競った）ときは、まれなのでそのまま送る
    try {
      await sendPushToUser(env, n.userId, n.payload);
      count++;
    } catch (e) {
      console.warn(`notify failed: ${n.userId}`, e);
    }
  }
  return count;
}
