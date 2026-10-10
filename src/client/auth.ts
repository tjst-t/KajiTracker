// ブラウザのパスキー（WebAuthn）と、ログインの API をつなぐ
//
// Safari は、パスキーの作成・確認（navigator.credentials.create / get）を「人がボタンを押したその流れの中」で
// 呼ばないと NotAllowedError で断る。押してから API で options を取る（await fetch）と、押した扱いが切れる。
// そこで options は画面を出したときに usePrepared で前もって取っておき、ボタンの click の中では
// await を挟まずに最初に startRegistration / startAuthentication を呼ぶ（下の loginWithPasskey などはそう作ってある）。
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api";

export type RegOptions = Parameters<typeof startRegistration>[0]["optionsJSON"];
export type AuthOptions = Parameters<typeof startAuthentication>[0]["optionsJSON"];

type Kind = "register" | "login" | "step-up";

const OPEN_IN_SAFARI = "LINE などのアプリの中で開いている場合は、Safari（または Chrome）で開き直してください。";

/** ブラウザがパスキーを出せなかった・取り消されたときに、分かる言葉にする */
function explain(kind: Kind) {
  return (e: unknown): never => {
    if (e instanceof ApiError) throw e;
    const name = (e as { name?: string })?.name;
    if (name === "NotAllowedError") {
      if (kind === "register")
        throw new ApiError(
          0,
          `パスキーを作れませんでした。iPhone では『設定 → [名前] → iCloud → パスワードとキーチェーン』がオンになっているか確かめてください。${OPEN_IN_SAFARI}取り消した場合は、もう一度押してください。`,
          "cancelled",
        );
      throw new ApiError(
        0,
        `パスキーで確認できませんでした。取り消した場合は、もう一度押してください。${OPEN_IN_SAFARI}${
          kind === "login" ? "この端末にパスキーが無いときは、ログイン済みの端末の「設定 → 端末を追加」で QR を出してください。" : ""
        }`,
        "cancelled",
      );
    }
    if (name === "AbortError") throw new ApiError(0, "パスキーの確認が取り消されました。もう一度押してください", "cancelled");
    if (name === "InvalidStateError") throw new ApiError(0, "この端末のパスキーは、もう登録されています", "already_registered");
    throw new ApiError(0, `パスキーを使えませんでした：${(e as Error)?.message ?? String(e)}`);
  };
}

// ---- options を取る（画面を出したとき・段を出したときに usePrepared から） ----

export const fetchLoginOptions = () => api<AuthOptions>("POST", "/auth/login/options");
export const fetchRegisterOptions = () => api<RegOptions>("POST", "/auth/register/options");
export const fetchStepUpOptions = () => api<AuthOptions>("POST", "/auth/step-up/options");
export const fetchInviteOptions = (token: string, displayName: string) =>
  api<RegOptions>("POST", "/invites/register/options", { token, displayName });

// ---- パスキーを使う（どれも、最初の await より前に startRegistration / startAuthentication を呼ぶ） ----

export async function loginWithPasskey(optionsJSON: AuthOptions) {
  const response = await startAuthentication({ optionsJSON }).catch(explain("login"));
  await api("POST", "/auth/login/verify", { response });
}

export async function registerPasskey(optionsJSON: RegOptions, name?: string) {
  const response = await startRegistration({ optionsJSON }).catch(explain("register"));
  return api<{ id: string; name: string }>("POST", "/auth/register/verify", { response, name });
}

export async function stepUp(optionsJSON: AuthOptions) {
  const response = await startAuthentication({ optionsJSON }).catch(explain("step-up"));
  await api("POST", "/auth/step-up/verify", { response });
}

/** 招待から初めて登録する：この端末のパスキー → Family に参加してログイン（名前は options を取るときに渡してある） */
export async function registerViaInvite(optionsJSON: RegOptions, token: string) {
  const response = await startRegistration({ optionsJSON }).catch(explain("register"));
  return api<{ familyId: string }>("POST", "/invites/register/verify", { token, response });
}

// ---- options を前もって用意しておく ----

/** challenge はサーバで5分。余裕を見て4分で取り直す */
const FRESH_MS = 4 * 60_000;

/**
 * options の取得は1本ずつ順に流す。challenge の Cookie（kaji-chal）は1つなので、
 * 最後に頼んだものが最後に届く（Cookie と画面の持つ options が食い違わない）ようにする
 */
let queue: Promise<unknown> = Promise.resolve();

export type Prepared<T> = {
  /** 用意ができている */
  ready: boolean;
  /** 用意に失敗した（step_up_required など） */
  failure: unknown;
  /** ボタンの click の中で呼ぶ。用意した options で ceremony をすぐ始める（失敗したら用意し直す） */
  start: <R>(ceremony: (options: T) => Promise<R>) => Promise<R>;
  reload: () => void;
};

/**
 * active のあいだ、パスキーの options を取っておく。古くなったら（4分）取り直す。
 * 同じ画面で2つを同時に active にしないこと（challenge の Cookie が1つのため）
 */
export function usePrepared<T>(active: boolean, fetchOptions: () => Promise<T>): Prepared<T> {
  const [prepared, setPrepared] = useState<{ options: T; at: number } | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [round, setRound] = useState(0);
  const fetchRef = useRef(fetchOptions);
  fetchRef.current = fetchOptions;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const reload = useCallback(() => setRound((r) => r + 1), []);

  useEffect(() => {
    setPrepared(null);
    setFailure(null);
    if (!active) return;
    let live = true;
    const run = queue.then(() => fetchRef.current());
    queue = run.catch(() => {});
    run.then(
      (options) => {
        if (!live) return;
        setPrepared({ options, at: Date.now() });
        timer.current = setTimeout(reload, FRESH_MS);
      },
      (e) => live && setFailure(e),
    );
    return () => {
      live = false;
      clearTimeout(timer.current);
    };
  }, [active, round, reload]);

  // iPhone は裏に回るとタイマーが止まる。戻ってきたときに古ければ取り直す
  useEffect(() => {
    if (!prepared) return;
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - prepared.at > FRESH_MS) reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [prepared, reload]);

  const start = <R,>(ceremony: (options: T) => Promise<R>): Promise<R> => {
    if (!prepared || Date.now() - prepared.at > FRESH_MS) {
      if (prepared) reload();
      return Promise.reject(new ApiError(0, "パスキーの用意をし直しています。少し待ってから、もう一度押してください", "not_ready"));
    }
    // ここより前に await を置かない（Safari が押した扱いを切る）
    const p = ceremony(prepared.options);
    clearTimeout(timer.current); // 使っている途中で取り直すと Cookie が替わるので止める
    setPrepared(null); // challenge は1回だけ使える
    p.catch(reload);
    return p;
  };

  return { ready: prepared !== null, failure, start, reload };
}

// ---- 大事な操作の前の確認（step-up） ----

let openStepUp: (() => Promise<void>) | null = null;

/** StepUpDialog が「パスキーでもう一度確認してください」の段を開く口を渡す */
export function setStepUpOpener(open: (() => Promise<void>) | null) {
  openStepUp = open;
}

/**
 * 大事な操作。「もう一度確認して」と言われたら、確認の段（StepUpDialog）を出し、
 * そこでボタンを押してパスキーを通してもらってからやり直す
 */
export async function withStepUp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.code === "step_up_required" && openStepUp) {
      await openStepUp();
      return fn();
    }
    throw e;
  }
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
