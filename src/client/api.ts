// API を呼ぶ。Cookie の CSRF 対策として、いつも X-Kaji-Client: 1 を付ける
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: { "X-Kaji-Client": "1", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `うまくいきませんでした（${res.status}）`, json?.code);
  return json as T;
}

export type Me = {
  user: { id: string; displayName: string; notifyTime: string };
  session: { id: string; via: SessionVia; stepUpOk: boolean };
  passkeyCount: number;
};
export type SessionVia = "passkey" | "device_ticket" | "recovery_ticket" | "bootstrap";
export type PasskeyItem = { id: string; name: string; createdAt: string; lastUsedAt: string | null };
export type SessionItem = {
  id: string;
  deviceLabel: string;
  via: SessionVia;
  issuedBy: string | null;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
};
