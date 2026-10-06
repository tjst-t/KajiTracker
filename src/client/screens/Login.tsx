import { useState } from "react";
import { loginWithPasskey } from "../auth";
import { errorText } from "../format";

/** S9 ログイン。新規登録の入口は置かない（招待の QR からだけ） */
export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = async () => {
    setBusy(true);
    setError(null);
    try {
      await loginWithPasskey();
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
      <button className="btn btn--primary btn--large" onClick={login} disabled={busy}>
        {busy ? "確認しています…" : "パスキーでログイン"}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="note">
        はじめて使うときは、家族から招待の QR を受け取ってください。
        <br />
        ほかの端末でログイン済みなら、その端末の「設定」にある「端末を追加」で QR を出せます。
      </p>
    </main>
  );
}
