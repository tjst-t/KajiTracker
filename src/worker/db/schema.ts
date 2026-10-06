// データの形。説明は docs/design.md の 1。
// 日付（*_on）は日本時間の YYYY-MM-DD、時刻（*_at）は UTC の ISO 文字列。
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = (name: string) => text(name).notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);

// ---- ユーザーとログイン ----

export const users = sqliteTable("users", {
  id: text().primaryKey(),
  displayName: text("display_name").notNull(),
  webauthnUserId: text("webauthn_user_id").notNull().unique(),
  notifyTime: text("notify_time").notNull().default("20:00"),
  createdAt: now("created_at"),
});

export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text().primaryKey(), // credential id（base64url）
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    publicKey: text("public_key").notNull(), // COSE 形式の公開鍵（base64url）
    counter: integer().notNull().default(0),
    transports: text(), // JSON 配列
    name: text().notNull(),
    createdAt: now("created_at"),
    lastUsedAt: text("last_used_at"),
  },
  (t) => [index("passkeys_user").on(t.userId)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text().primaryKey(), // Cookie の値の SHA-256
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    via: text({ enum: ["passkey", "device_ticket", "recovery_ticket", "bootstrap"] }).notNull(),
    issuedByUserId: text("issued_by_user_id").references(() => users.id, { onDelete: "set null" }),
    deviceLabel: text("device_label").notNull(),
    stepUpAt: text("step_up_at"),
    createdAt: now("created_at"),
    lastUsedAt: now("last_used_at"),
  },
  (t) => [index("sessions_user").on(t.userId)],
);

export const loginTickets = sqliteTable("login_tickets", {
  id: text().primaryKey(), // 札の値の SHA-256
  kind: text({ enum: ["device", "recovery", "bootstrap"] }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  issuedByUserId: text("issued_by_user_id").references(() => users.id, { onDelete: "set null" }),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  usedDeviceLabel: text("used_device_label"),
  createdAt: now("created_at"),
});

export const webauthnChallenges = sqliteTable("webauthn_challenges", {
  id: text().primaryKey(),
  challenge: text().notNull(),
  purpose: text({ enum: ["register", "authenticate", "step_up"] }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  /** 招待から新しく登録するときの、まだ作っていないユーザーの情報（JSON） */
  data: text(),
  expiresAt: text("expires_at").notNull(),
});

export const rateLimits = sqliteTable(
  "rate_limits",
  {
    key: text().notNull(),
    windowStart: integer("window_start").notNull(),
    count: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

// ---- Family ----

export const families = sqliteTable("families", {
  id: text().primaryKey(),
  name: text().notNull(),
  createdAt: now("created_at"),
});

export const familyMembers = sqliteTable(
  "family_members",
  {
    familyId: text("family_id").notNull().references(() => families.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text({ enum: ["admin", "member"] }).notNull(),
    joinedAt: now("joined_at"),
  },
  (t) => [primaryKey({ columns: [t.familyId, t.userId] }), index("family_members_user").on(t.userId)],
);

export const invites = sqliteTable("invites", {
  id: text().primaryKey(), // 招待の値の SHA-256
  familyId: text("family_id").notNull().references(() => families.id, { onDelete: "cascade" }),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  usedBy: text("used_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: now("created_at"),
});

// ---- 家事と記録 ----

export const chores = sqliteTable(
  "chores",
  {
    id: text().primaryKey(),
    familyId: text("family_id").notNull().references(() => families.id, { onDelete: "cascade" }),
    name: text().notNull(),
    scheduleType: text("schedule_type", { enum: ["interval", "calendar"] }).notNull(),
    intervalDays: integer("interval_days"),
    firstDueOn: text("first_due_on"),
    calendarRule: text("calendar_rule"), // JSON。形は src/shared/schedule.ts
    assigneeUserId: text("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
    notifyTime: text("notify_time"),
    archivedAt: text("archived_at"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: now("created_at"),
    updatedAt: now("updated_at"),
  },
  (t) => [index("chores_family").on(t.familyId)],
);

export const logs = sqliteTable(
  "logs",
  {
    id: text().primaryKey(),
    choreId: text("chore_id").notNull().references(() => chores.id, { onDelete: "cascade" }),
    familyId: text("family_id").notNull().references(() => families.id, { onDelete: "cascade" }),
    // 抜けた人の記録も残す（統計に名前で出す）。ユーザーそのものを消すときは別に考える
    userId: text("user_id").notNull().references(() => users.id),
    doneOn: text("done_on").notNull(),
    createdAt: now("created_at"),
    deletedAt: text("deleted_at"),
  },
  (t) => [index("logs_chore_done").on(t.choreId, t.doneOn), index("logs_family_done").on(t.familyId, t.doneOn)],
);

// ---- 通知 ----

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text().primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    endpoint: text().notNull(),
    p256dh: text().notNull(),
    auth: text().notNull(),
    deviceLabel: text("device_label").notNull(),
    createdAt: now("created_at"),
    lastSuccessAt: text("last_success_at"),
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint").on(t.endpoint), index("push_subscriptions_user").on(t.userId)],
);

export const notificationsSent = sqliteTable(
  "notifications_sent",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    choreId: text("chore_id").notNull().references(() => chores.id, { onDelete: "cascade" }),
    dueOn: text("due_on").notNull(),
    sentAt: now("sent_at"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.choreId, t.dueOn] })],
);
