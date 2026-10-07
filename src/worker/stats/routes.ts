// Family 全体の統計。計算は src/shared/stats.ts、返す形は docs/design.md の 5「統計」。
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { fail } from "../context";
import { chores, familyMembers, logs, users } from "../db/schema";
import { requireMember } from "../families/routes";
import { scheduleOf } from "../chores/routes";
import { isDateStr, todayInTokyo } from "../../shared/date";
import { type StatsUser, computeStats, monthRange } from "../../shared/stats";

export const statsRoutes = new Hono<AppEnv>()
  /** ?from=YYYY-MM-DD&to=YYYY-MM-DD（日本時間、両端を含む）。省いた側は今月の初日・末日 */
  .get("/families/:fid/stats", async (c) => {
    const fid = c.req.param("fid");
    await requireMember(c, fid);
    const today = todayInTokyo();
    const month = monthRange(today);
    const from = c.req.query("from") || month.from;
    const to = c.req.query("to") || month.to;
    if (!isDateStr(from) || !isDateStr(to)) fail(400, "期間を日付（YYYY-MM-DD）で入れてください");
    if (from > to) fail(400, "期間の始めが終わりより後になっています");

    const db = c.get("db");
    const [members, choreRows, logRows] = await Promise.all([
      db
        .select({ userId: users.id, name: users.displayName })
        .from(familyMembers)
        .innerJoin(users, eq(familyMembers.userId, users.id))
        .where(eq(familyMembers.familyId, fid))
        .orderBy(asc(familyMembers.joinedAt))
        .all(),
      db.select().from(chores).where(eq(chores.familyId, fid)).all(),
      // 期限の計算に期間の前の記録も要るので、Family の記録をすべて引く（取り消しは computeStats で外す）
      db
        .select({ choreId: logs.choreId, userId: logs.userId, userName: users.displayName, doneOn: logs.doneOn, deletedAt: logs.deletedAt })
        .from(logs)
        .innerJoin(users, eq(logs.userId, users.id))
        .where(eq(logs.familyId, fid))
        .all(),
    ]);

    const statsUsers: StatsUser[] = members.map((m) => ({ ...m, isMember: true }));
    const seen = new Set(statsUsers.map((u) => u.userId));
    for (const l of logRows) {
      if (seen.has(l.userId)) continue;
      seen.add(l.userId);
      statsUsers.push({ userId: l.userId, name: l.userName, isMember: false });
    }

    const stats = computeStats({
      chores: choreRows.map((ch) => ({
        id: ch.id,
        name: ch.name,
        schedule: scheduleOf(ch),
        archivedOn: ch.archivedAt ? todayInTokyo(new Date(ch.archivedAt)) : null,
      })),
      logs: logRows,
      users: statsUsers,
      from,
      to,
      today,
    });
    return c.json({ today, ...stats });
  });
