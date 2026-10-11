// TODO（一回限り）の型と、済みにする・取り消すの手順。API は src/worker/todos/routes.ts
import { todayInTokyo } from "../shared/date";
import { api } from "./api";

export type SubtaskView = {
  id: string;
  todoId: string;
  title: string;
  done: boolean;
  doneAt: string | null;
  doneByName: string | null;
  sortOrder: number;
};

export type TodoView = {
  id: string;
  familyId: string;
  title: string;
  memo: string | null;
  hasMemo: boolean;
  dueOn: string | null;
  /** 済み・期限なしは null */
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
  createdAt: string;
  updatedAt: string;
  subtasks: SubtaskView[];
  progress: { done: number; total: number };
};

export type TodoDetail = TodoView & { today: string };

/** 判子（Hanko）に渡す形 */
export const dueOf = (t: TodoView) => ({ status: t.dueStatus, daysLate: t.daysLate, dueOn: t.dueOn });

/** 済みにしたこと。取り消すときに、いっしょに済みにしたサブタスクも戻す */
export type Completed = { todo: TodoView; subtaskIds: string[] };

/** 済みにする。withSubtasks なら残りのサブタスクも済みにしてから */
export async function completeTodo(todo: TodoView, withSubtasks: boolean): Promise<Completed> {
  const subtaskIds = withSubtasks ? todo.subtasks.filter((s) => !s.done).map((s) => s.id) : [];
  await Promise.all(subtaskIds.map((id) => api("PATCH", `/subtasks/${id}`, { done: true })));
  const t = await api<TodoView>("PATCH", `/todos/${todo.id}`, { done: true });
  return { todo: t, subtaskIds };
}

export async function undoComplete({ todo, subtaskIds }: Completed): Promise<void> {
  await api("PATCH", `/todos/${todo.id}`, { done: false });
  await Promise.all(subtaskIds.map((id) => api("PATCH", `/subtasks/${id}`, { done: false })));
}

/** 残っているサブタスクの数 */
export const leftSubtasks = (t: TodoView) => t.progress.total - t.progress.done;

/** 時刻（ISO）の日本時間の日付 */
export const dateOfIso = (iso: string) => todayInTokyo(new Date(iso));
