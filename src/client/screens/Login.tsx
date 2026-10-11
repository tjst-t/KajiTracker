import { useState, useSyncExternalStore } from "react";
import { fetchLoginOptions, loginWithPasskey, usePrepared } from "../auth";
import { errorText } from "../format";
import { getSyncState, subscribeSync } from "../shopping-store";

/** S9 ログイン。新規登録の入口は置かない（招待の QR からだけ） */
export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // options は画面を出したときに取っておき、押したらすぐパスキーを出す（Safari は押してから通信を待つと断る）
  const prepared = usePrepared(true, fetchLoginOptions);
  const unsent = useSyncExternalStore(subscribeSync, getSyncState).ops.length;

  const login = async () => {
    setBusy(true);
    setError(null);
    try {
      await prepared.start(loginWithPasskey);
      onLoggedIn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page page--login">
      <h1 className="wordmark">KajiTracker</h1>
      <p className="lede">
        家事の<span className="nobr">「前にやった日」</span>と<span className="nobr">「次にやる日」</span>を、家族で覚えておく。
      </p>
      {unsent > 0 && (
        <p className="notice" role="status">
          この端末に、まだ送っていない買い物の変更が {unsent} 件あります。ログインし直すと送ります。
        </p>
      )}
      <button className="btn btn--primary btn--large" onClick={login} disabled={busy || !prepared.ready}>
        {busy ? "確認しています…" : prepared.ready ? "パスキーでログイン" : "用意しています…"}
      </button>
      {(error || !!prepared.failure) && (
        <p className="error" role="alert">
          {error ?? errorText(prepared.failure)}
        </p>
      )}
      {!!prepared.failure && (
        <button className="btn" onClick={prepared.reload}>
          もう一度用意する
        </button>
      )}
      <p className="note">
        はじめて使うときは、家族から招待の QR を受け取ってください。
        <br />
        ほかの端末でログイン済みなら、その端末の「設定」にある「端末を追加」で QR を出せます。
      </p>
    </main>
  );
}
