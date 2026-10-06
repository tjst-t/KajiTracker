import { useEffect, useRef, useState } from "react";
import { ApiError, type Me, api } from "../api";
import { loginWithPasskey, registerViaInvite } from "../auth";
import { errorText } from "../format";

type Info = { valid: false } | { valid: true; familyId: string; familyName: string; invitedBy: string; alreadyMember: boolean };

/** S10 招待を受ける（#invite=…）。初めての人は名前とパスキー、アカウントがある人はログインして参加 */
export function InviteScreen({ token, me, onJoined, onCancel }: { token: string; me: Me | null; onJoined: (familyId: string) => void; onCancel: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api<Info>("POST", "/invites/info", { token })
      .then(setInfo)
      .catch((e) => setError(errorText(e)));
  }, [token]);

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      onJoined(await fn());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => (await api<{ familyId: string }>("POST", "/invites/accept", { token })).familyId;

  return (
    <main className="page page--narrow">
      <h1 className="wordmark wordmark--small">KajiTracker</h1>

      {!info && !error && <p aria-busy="true">招待を確かめています…</p>}

      {info && !info.valid && (
        <div className="stack">
          <h2>この招待は使えません</h2>
          <p>招待の期限は出してから24時間で、1回しか使えません。招待してくれた人に、もう一度 QR を出してもらってください。</p>
          <button className="btn" onClick={onCancel}>
            閉じる
          </button>
        </div>
      )}

      {info?.valid && (
        <div className="stack">
          <h2 className="invite-title">
            {info.invitedBy}さんが<span className="nobr">「{info.familyName}」</span>に招待しています
          </h2>

          {me && info.alreadyMember && (
            <>
              <p>{me.user.displayName}さんは、もうこの Family に入っています。</p>
              <button className="btn btn--primary" onClick={() => onJoined(info.familyId)}>
                「{info.familyName}」を開く
              </button>
            </>
          )}

          {me && !info.alreadyMember && (
            <>
              <p>{me.user.displayName}さんとして参加します。</p>
              <button className="btn btn--primary" disabled={busy} onClick={() => void act(accept)}>
                参加する
              </button>
              <button className="btn btn--quiet" onClick={onCancel}>
                参加しない
              </button>
            </>
          )}

          {!me && (
            <>
              <div className="segmented" role="tablist" aria-label="アカウントの有無">
                <button role="tab" aria-selected={mode === "new"} onClick={() => setMode("new")}>
                  はじめて使う
                </button>
                <button role="tab" aria-selected={mode === "existing"} onClick={() => setMode("existing")}>
                  アカウントを持っている
                </button>
              </div>

              {mode === "new" ? (
                <form
                  className="stack"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(async () => (await registerViaInvite(token, name.trim())).familyId);
                  }}
                >
                  <p>家族に見える名前を入れて、この端末のパスキーを作ります。次からは顔認証や指紋でログインできます。</p>
                  <label className="field">
                    <span>名前</span>
                    <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} required placeholder="例：はなこ" />
                  </label>
                  <button className="btn btn--primary" type="submit" disabled={busy || !name.trim()}>
                    {busy ? "作っています…" : "パスキーを作って参加する"}
                  </button>
                </form>
              ) : (
                <div className="stack">
                  <p>ほかの Family でもう KajiTracker を使っているなら、そのアカウントでログインして参加します。</p>
                  <button
                    className="btn btn--primary"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await loginWithPasskey();
                        // すでに入っていたなら、そのまま開く
                        return accept().catch((e) => {
                          if (e instanceof ApiError && e.code === "already_member") return info.familyId;
                          throw e;
                        });
                      })
                    }
                  >
                    パスキーでログインして参加する
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
