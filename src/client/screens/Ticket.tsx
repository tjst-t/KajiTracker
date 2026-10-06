import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { registerPasskey } from "../auth";
import { errorText } from "../format";

type Info = { valid: false } | { valid: true; kind: "device" | "recovery" | "bootstrap" };
type Step = "checking" | "invalid" | "name" | "redeeming" | "passkey" | "error";

/** S11 札で入る（#login=…）。最初の1人なら名前を聞く。入ったら、この端末のパスキーを作る */
export function TicketScreen({ token, onDone }: { token: string; onDone: () => void }) {
  const [step, setStep] = useState<Step>("checking");
  const [name, setName] = useState("");
  const [passkeyName, setPasskeyName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const redeem = async (displayName?: string) => {
    setStep("redeeming");
    setError(null);
    try {
      await api("POST", "/auth/redeem", { token, displayName });
      setStep("passkey");
    } catch (e) {
      setError(errorText(e));
      setStep(displayName !== undefined ? "name" : "error");
    }
  };

  // 札は1回しか使えないので、開発時の二重実行でも1回だけ問い合わせる
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api<Info>("POST", "/auth/ticket-info", { token })
      .then((info) => {
        if (!info.valid) setStep("invalid");
        else if (info.kind === "bootstrap") setStep("name");
        else void redeem();
      })
      .catch((e) => {
        setError(errorText(e));
        setStep("error");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const createPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      await registerPasskey(passkeyName.trim() || undefined);
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page page--narrow">
      <h1 className="wordmark wordmark--small">KajiTracker</h1>

      {(step === "checking" || step === "redeeming") && <p aria-busy="true">札を確かめています…</p>}

      {step === "invalid" && (
        <>
          <h2>この札は使えません</h2>
          <p>札の期限は出してから10分で、1回しか使えません。札を出した端末で、もう一度 QR を出してもらってください。</p>
          <button className="btn" onClick={onDone}>
            ログイン画面へ
          </button>
        </>
      )}

      {step === "name" && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void redeem(name.trim());
          }}
        >
          <h2>はじめまして</h2>
          <p>家族に見える名前を入れてください。あとから変えられます。</p>
          <label className="field">
            <span>名前</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} required autoFocus placeholder="例：たくみ" />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn--primary" type="submit" disabled={!name.trim()}>
            はじめる
          </button>
        </form>
      )}

      {step === "passkey" && (
        <div className="stack">
          <h2>この端末のパスキーを作る</h2>
          <p>次からは、この端末の顔認証や指紋でログインできます。パスキーは10分以内に作ってください。</p>
          <label className="field">
            <span>パスキーの名前（省くと端末の種類から付けます）</span>
            <input value={passkeyName} onChange={(e) => setPasskeyName(e.target.value)} maxLength={40} placeholder="例：たくみの iPhone" />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn--primary" onClick={createPasskey} disabled={busy}>
            {busy ? "作っています…" : "パスキーを作る"}
          </button>
          <button className="btn btn--quiet" onClick={onDone}>
            あとで作る
          </button>
        </div>
      )}

      {step === "error" && (
        <>
          <p className="error" role="alert">
            {error}
          </p>
          <button className="btn" onClick={onDone}>
            ログイン画面へ
          </button>
        </>
      )}
    </main>
  );
}
