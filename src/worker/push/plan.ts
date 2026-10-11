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
  /** 一回限りの TODO。期限が今日で未完了のものだけ送る */
  todos: {
    id: string;
    familyId: string;
    title: string;
    dueOn: DateStr | null;
    assigneeUserId: string | null;
    /** TODO の通知の時刻。あれば人の時刻より優先する */
    notifyTime: string | null;
    done: boolean;
  }[];
  /** もう送った分（notifications_sent） */
  sent: { userId: string; choreId: string; dueOn: DateStr }[];
  /** もう送った TODO の分（todo_notifications_sent） */
  sentTodos: { userId: string; todoId: string; dueOn: DateStr }[];
};

/** 1人に送る1通 */
export type PlannedNotification = {
  userId: string;
  payload: PushPayload;
  /** notifications_sent に入れる分 */
  items: { choreId: string; dueOn: DateStr }[];
  /** todo_notifications_sent に入れる分 */
  todoItems: { todoId: string; dueOn: DateStr }[];
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

/** いまの時刻帯に送る通知。1人に1通（同じ時刻帯の家事と TODO はまとめる） */
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
  const sentTodos = new Set(input.sentTodos.map((s) => `${s.userId}|${s.todoId}|${s.dueOn}`));
  /** 担当者がいればその人だけ（もう Family にいなければ、担当なしと同じに全員）。時刻はもの→人の順 */
  const recipients = (familyId: string, assigneeUserId: string | null, notifyTime: string | null) => {
    const members = membersOf.get(familyId) ?? [];
    const assignee = members.find((m) => m.userId === assigneeUserId);
    return (assignee ? [assignee] : members).filter((m) => inSlot(notifyTime ?? m.notifyTime));
  };

  // 人ごとに、送る家事と TODO を集める（入力の順を保つ）
  const byUser = new Map<string, { familyId: string; choreId: string; name: string }[]>();
  const todosByUser = new Map<string, { familyId: string; todoId: string; name: string }[]>();
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

    for (const m of recipients(chore.familyId, chore.assigneeUserId, chore.notifyTime)) {
      if (sent.has(`${m.userId}|${chore.id}|${today}`)) continue;
      byUser.set(m.userId, [...(byUser.get(m.userId) ?? []), { familyId: chore.familyId, choreId: chore.id, name: chore.name }]);
    }
  }
  // TODO は期限の当日で未完了のものだけ（遅れ・期限なし・済みは外れる）
  for (const todo of input.todos) {
    if (todo.done || todo.dueOn !== today) continue;
    for (const m of recipients(todo.familyId, todo.assigneeUserId, todo.notifyTime)) {
      if (sentTodos.has(`${m.userId}|${todo.id}|${today}`)) continue;
      todosByUser.set(m.userId, [...(todosByUser.get(m.userId) ?? []), { familyId: todo.familyId, todoId: todo.id, name: todo.title }]);
    }
  }

  const users = [...new Set([...byUser.keys(), ...todosByUser.keys()])];
  return users.map((userId) => {
    const chores = byUser.get(userId) ?? [];
    const todos = todosByUser.get(userId) ?? [];
    const withFamily = (familyCount.get(userId) ?? 0) > 1;
    return {
      userId,
      payload: { ...titleAndBody(chores, todos, withFamily, familyName), url: "/" },
      items: chores.map((c) => ({ choreId: c.choreId, dueOn: today })),
      todoItems: todos.map((t) => ({ todoId: t.todoId, dueOn: today })),
    };
  });
}

type Named = { familyId: string; name: string };

/**
 * 題名と本文。家事だけなら「今日の家事」、TODO だけなら「今日の TODO」。
 * 両方あれば1通にまとめる（「今日の家事：ゴミ出し・洗濯／TODO：役所に電話」）
 */
function titleAndBody(chores: Named[], todos: Named[], withFamily: boolean, familyName: Map<string, string>) {
  if (todos.length === 0) return { title: "今日の家事", body: bodyOf(chores, withFamily, familyName, "／") };
  if (chores.length === 0) return { title: "今日の TODO", body: bodyOf(todos, withFamily, familyName, "／") };
  // まとめるときは「／」を家事と TODO の区切りに使うので、Family の区切りは「、」にする
  return {
    title: "今日の家事",
    body: `今日の家事：${bodyOf(chores, withFamily, familyName, "、")}／TODO：${bodyOf(todos, withFamily, familyName, "、")}`,
  };
}

/** 本文。Family が複数ある人には Family 名をつける（「自宅：ゴミ出し・洗濯／実家：草むしり」） */
function bodyOf(list: Named[], withFamily: boolean, familyName: Map<string, string>, familySep: string): string {
  if (!withFamily) return list.map((c) => c.name).join("・");
  const groups = new Map<string, string[]>();
  for (const c of list) groups.set(c.familyId, [...(groups.get(c.familyId) ?? []), c.name]);
  return [...groups].map(([fid, names]) => `${familyName.get(fid) ?? ""}：${names.join("・")}`).join(familySep);
}
