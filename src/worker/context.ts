import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Db } from "./db";
import type { sessions, users } from "./db/schema";

/** 要求が来た画面（ORIGINS のうちの1つ） */
export type Site = { origin: string; rpId: string; secure: boolean };

export type Auth = { user: typeof users.$inferSelect; session: typeof sessions.$inferSelect };

export type AppEnv = {
  Bindings: Env;
  Variables: { db: Db; site: Site; auth: Auth | null };
};

export type Ctx = Context<AppEnv>;

/** 画面に返すエラー。code は画面が分岐に使う */
export function fail(status: ContentfulStatusCode, message: string, code?: string): never {
  throw new HTTPException(status, {
    message,
    res: new Response(JSON.stringify({ error: message, code }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }),
  });
}

export function requireAuth(c: Ctx): Auth {
  const a = c.get("auth");
  if (!a) fail(401, "ログインしてください", "unauthenticated");
  return a;
}

export const nowIso = () => new Date().toISOString();
export const isoAfter = (ms: number) => new Date(Date.now() + ms).toISOString();
export const isoBefore = (ms: number) => new Date(Date.now() - ms).toISOString();
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
