// 当日の通知で、だれに何を送るかを決める。説明は docs/design.md の 3。
// DB にも時刻にも触らない（入力と now だけで決まる）。読み出しと送信は notify.ts。
import { type DateStr, todayInTokyo } from "../../shared/date";
import { type Schedule, evaluate } from "../../shared/schedule";
import type { PushPayload } from "./send";

export type PlanInput = {
  families: { id: string; name: string }[];
  /** Family のメンバーと、その人の通知の時刻（"HH:MM"） */
  members: { familyId: string; userId: string; notifyTime: string }[];
  chores: {
    id: string;
    familyId: string;
    name: string;
    schedule: Schedule;
    assigneeUserId: string | null;
    /** 家事の通知の時刻。あれば人の時刻より優先する */
    notifyTime: string | null;
    archived: boolean;
    /** 取り消していない記録のやった日 */
    doneOns: DateStr[];
  }[];
  /** もう送った分（notifications_sent） */
  sent: { userId: string; choreId: string; dueOn: DateStr }[];
};

/** 1人に送る1通 */
export type PlannedNotification = {
  userId: string;
  payload: PushPayload;
  /** notifications_sent に入れる分 */
  items: { choreId: string; dueOn: DateStr }[];
};

/** Cron の間隔（分） */
export const SLOT_MINUTES = 15;
const JST_OFFSET_MS = 9 * 3_600_000;

/** 日本時間のいまの時刻帯 [start, start+15分) の始まり（0 時からの分） */
export function slotStartInTokyo(now: Date): number {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const minutes = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  return minutes - (minutes % SLOT_MINUTES);
}

function minutesOf(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** いまの時刻帯に送る通知。1人に1通（同じ時刻帯の家事はまとめる） */
export function planNotifications(input: PlanInput, now: Date): PlannedNotification[] {
  const today = todayInTokyo(now);
  const slot = slotStartInTokyo(now);
  const inSlot = (hhmm: string) => {
    const m = minutesOf(hhmm);
    return m !== null && m >= slot && m < slot + SLOT_MINUTES;
  };

  const familyName = new Map(input.families.map((f) => [f.id, f.name]));
  const membersOf = new Map<string, PlanInput["members"]>();
  const familyCount = new Map<string, number>();
  for (const m of input.members) {
    membersOf.set(m.familyId, [...(membersOf.get(m.familyId) ?? []), m]);
    familyCount.set(m.userId, (familyCount.get(m.userId) ?? 0) + 1);
  }
  const sent = new Set(input.sent.map((s) => `${s.userId}|${s.choreId}|${s.dueOn}`));

  // 人ごとに、送る家事を集める（入力の順を保つ）
  const byUser = new Map<string, { familyId: string; choreId: string; name: string }[]>();
  for (const chore of input.chores) {
    if (chore.archived) continue;
    let ev;
    try {
      ev = evaluate(chore.schedule, chore.doneOns, today);
    } catch (e) {
      console.warn(`evaluate failed: ${chore.id}`, e);
      continue;
    }
    // 期限の当日だけ（遅れ・まだ先・今日やってあるものは外れる）
    if (ev.status !== "today") continue;

    const members = membersOf.get(chore.familyId) ?? [];
    // 担当者がいればその人だけ（もう Family にいなければ、担当なしと同じに全員）
    const assignee = members.find((m) => m.userId === chore.assigneeUserId);
    for (const m of assignee ? [assignee] : members) {
      if (!inSlot(chore.notifyTime ?? m.notifyTime)) continue;
      if (sent.has(`${m.userId}|${chore.id}|${today}`)) continue;
      byUser.set(m.userId, [...(byUser.get(m.userId) ?? []), { familyId: chore.familyId, choreId: chore.id, name: chore.name }]);
    }
  }

  return [...byUser].map(([userId, list]) => ({
    userId,
    payload: { title: "今日の家事", body: bodyOf(list, (familyCount.get(userId) ?? 0) > 1, familyName), url: "/" },
    items: list.map((c) => ({ choreId: c.choreId, dueOn: today })),
  }));
}

/** 本文。Family が複数ある人には Family 名をつける（「自宅：ゴミ出し・洗濯／実家：草むしり」） */
function bodyOf(list: { familyId: string; name: string }[], withFamily: boolean, familyName: Map<string, string>): string {
  if (!withFamily) return list.map((c) => c.name).join("・");
  const groups = new Map<string, string[]>();
  for (const c of list) groups.set(c.familyId, [...(groups.get(c.familyId) ?? []), c.name]);
  return [...groups].map(([fid, names]) => `${familyName.get(fid) ?? ""}：${names.join("・")}`).join("／");
}
