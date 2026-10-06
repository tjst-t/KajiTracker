// ブラウザのパスキー（WebAuthn）と、ログインの API をつなぐ
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { ApiError, api } from "./api";

/** ブラウザがパスキーを出せなかった・取り消されたときに、分かる言葉にする */
function explain(e: unknown): never {
  if (e instanceof ApiError) throw e;
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "AbortError") throw new ApiError(0, "パスキーの確認が取り消されました。もう一度押してください", "cancelled");
  if (name === "InvalidStateError") throw new ApiError(0, "この端末のパスキーは、もう登録されています", "already_registered");
  throw new ApiError(0, `パスキーを使えませんでした：${(e as Error)?.message ?? String(e)}`);
}

export async function loginWithPasskey() {
  const optionsJSON = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("POST", "/auth/login/options");
  const response = await startAuthentication({ optionsJSON }).catch(explain);
  await api("POST", "/auth/login/verify", { response });
}

export async function registerPasskey(name?: string) {
  const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("POST", "/auth/register/options");
  const response = await startRegistration({ optionsJSON }).catch(explain);
  return api<{ id: string; name: string }>("POST", "/auth/register/verify", { response, name });
}

export async function stepUp() {
  const optionsJSON = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("POST", "/auth/step-up/options");
  const response = await startAuthentication({ optionsJSON }).catch(explain);
  await api("POST", "/auth/step-up/verify", { response });
}

/** 大事な操作。「もう一度確認して」と言われたらパスキーを通してやり直す */
export async function withStepUp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.code === "step_up_required") {
      await stepUp();
      return fn();
    }
    throw e;
  }
}

/** 招待から初めて登録する：名前 → この端末のパスキー → Family に参加してログイン */
export async function registerViaInvite(token: string, displayName: string) {
  const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("POST", "/invites/register/options", { token, displayName });
  const response = await startRegistration({ optionsJSON }).catch(explain);
  return api<{ familyId: string }>("POST", "/invites/register/verify", { token, response });
}

/**
 * URL のフラグメントから札（#login=…）か招待（#invite=…）を取り出し、すぐ URL から消す（履歴にも残さない）。
 * フラグメントはサーバのアクセスログにも Referer にも残らない
 */
export function takeFragmentFromUrl(): { kind: "login" | "invite"; token: string } | null {
  const m = /^#(login|invite)=([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (!m) return null;
  history.replaceState(null, "", location.pathname + location.search);
  return { kind: m[1] as "login" | "invite", token: m[2]! };
}
