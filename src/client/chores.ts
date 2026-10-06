import type { Cycle, Schedule, Status } from "../shared/schedule";

export type LogView = { id: string; doneOn: string; userId: string; userName: string; createdAt?: string };

export type ChoreView = {
  id: string;
  familyId: string;
  name: string;
  schedule: Schedule;
  assigneeUserId: string | null;
  assigneeName: string | null;
  groupId: string | null;
  groupName: string | null;
  notifyTime: string | null;
  archived: boolean;
  dueOn: string | null;
  status: Status;
  daysLate: number;
  lastLog: LogView | null;
};

export type ChoreDetail = ChoreView & {
  logs: LogView[];
  cycles: Cycle[];
  today: string;
  stats: {
    doneCount: number;
    onTimeRate: number | null;
    averageDaysLate: number | null;
    missedCount: number;
    averageInterval: number | null;
    plannedInterval: number | null;
  };
};

export type ChoreInput = {
  name: string;
  schedule: unknown;
  assigneeUserId: string | null;
  notifyTime: string | null;
};
