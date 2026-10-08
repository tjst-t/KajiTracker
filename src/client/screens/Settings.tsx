import { useCallback, useEffect, useState } from "react";
import { type Me, type PasskeyItem, type SessionItem, type SessionVia, api } from "../api";
import { registerPasskey, withStepUp } from "../auth";
import { type IssuedQr, QrDialog } from "../components/QrDialog";
import { errorText, formatDateTime } from "../format";
import { type PushState, getPushState, turnOffPush, turnOnPush } from "../push";

const TIMES = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`);

function viaText(via: SessionVia, issuedBy: string | null): string {
  switch (via) {
    case "passkey":
      return "パスキーでログイン";
    case "device_ticket":
      return "端末を追加の QR で入った";
    case "recovery_ticket":
      return `${issuedBy ?? "管理者"}さんが出した札で入った`;
    case "bootstrap":
      return "最初の登録で入った";
  }
}

/** S8 設定（自分）：名前・通知の時刻・パスキー・ログイン中の端末・端末を追加 */
export function Settings({ me, onChanged, onLoggedOut }: { me: Me; onChanged: () => Promise<void>; onLoggedOut: () => void }) {
  const [passkeys, setPasskeys] = useState<PasskeyItem[]>([]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [name, setName] = useState(me.user.displayName);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    const [p, s] = await Promise.all([api<PasskeyItem[]>("GET", "/me/passkeys"), api<SessionItem[]>("GET", "/me/sessions")]);
    setPasskeys(p);
    setSessions(s);
  }, []);

  useEffect(() => {
    reload().catch((e) => setMessage({ kind: "error", text: errorText(e) }));
  }, [reload]);

  /** 操作を1つ走らせ、結果を画面の上に出す */
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      await Promise.all([reload(), onChanged()]);
      setMessage({ kind: "ok", text: done });
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <h1>設定</h1>
      {message && (
        <p className={message.kind === "ok" ? "notice notice--ok" : "error"} role={message.kind === "ok" ? "status" : "alert"}>
          {message.text}
        </p>
      )}

      <section className="section" aria-labelledby="s-you">
        <h2 id="s-you">あなた</h2>
        <form
          className="row-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api("PATCH", "/me", { displayName: name }), "名前を変えました");
          }}
        >
          <label className="field">
            <span>名前</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} required />
          </label>
          <button className="btn" type="submit" disabled={busy || name.trim() === me.user.displayName}>
            名前を保存
          </button>
        </form>
        <label className="field">
          <span>通知の時刻（家事の当日に届きます）</span>
          <select
            value={me.user.notifyTime}
            disabled={busy}
            onChange={(e) => void run(() => api("PATCH", "/me", { notifyTime: e.target.value }), `通知の時刻を ${e.target.value} にしました`)}
          >
            {TIMES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <PushToggle />
      </section>

      <section className="section" aria-labelledby="s-passkeys">
        <h2 id="s-passkeys">パスキー</h2>
        {passkeys.length === 0 ? (
          <p className="muted">まだありません。この端末のパスキーを作ると、次から顔認証や指紋でログインできます。</p>
        ) : (
          <ul className="list">
            {passkeys.map((p) => (
              <li key={p.id} className="list__item">
                <div>
                  <p className="list__title">{p.name}</p>
                  <p className="list__meta">
                    登録 {formatDateTime(p.createdAt)}、{p.lastUsedAt ? `最後に使った ${formatDateTime(p.lastUsedAt)}` : "ログインにはまだ使っていません"}
                  </p>
                </div>
                <button
                  className="btn btn--danger-quiet"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`パスキー「${p.name}」を削除しますか？ その端末では、このパスキーでログインできなくなります。`))
                      void run(() => withStepUp(() => api("DELETE", `/me/passkeys/${encodeURIComponent(p.id)}`)), `「${p.name}」を削除しました`);
                  }}
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        )}
        <button className="btn" disabled={busy} onClick={() => void run(() => withStepUp(() => registerPasskey()), "この端末のパスキーを作りました")}>
          この端末のパスキーを作る
        </button>
      </section>

      <section className="section" aria-labelledby="s-sessions">
        <h2 id="s-sessions">ログイン中の端末</h2>
        <ul className="list">
          {sessions.map((s) => (
            <li key={s.id} className="list__item">
              <div>
                <p className="list__title">
                  {s.deviceLabel}
                  {s.current && <span className="tag">この端末</span>}
                </p>
                <p className="list__meta">
                  {viaText(s.via, s.issuedBy)}、最後に使った {formatDateTime(s.lastUsedAt)}
                </p>
              </div>
              {!s.current && (
                <button
                  className="btn btn--danger-quiet"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`「${s.deviceLabel}」を締め出しますか？ その端末はログアウトされます。`))
                      void run(() => withStepUp(() => api("DELETE", `/me/sessions/${s.id}`)), `「${s.deviceLabel}」を締め出しました`);
                  }}
                >
                  締め出す
                </button>
              )}
            </li>
          ))}
        </ul>
        <button className="btn btn--primary" disabled={busy} onClick={() => setAdding(true)}>
          端末を追加
        </button>
        <p className="muted">スマホでログインしたまま PC でも使いたいときなどに。QR を出して、新しい端末で読み取ります。</p>
      </section>

      <section className="section">
        <button
          className="btn btn--quiet"
          disabled={busy}
          onClick={async () => {
            await api("POST", "/auth/logout").catch(() => {});
            onLoggedOut();
          }}
        >
          ログアウト
        </button>
      </section>

      {adding && (
        <QrDialog
          title="端末を追加"
          intro="新しい端末のカメラで読み取ってください。PC にはリンクを送っても入れます。"
          caution="1回使うと終わりです。このリンクは家族にも送らないでください（あなたとして入れてしまいます）。"
          issue={() => withStepUp(() => api<IssuedQr>("POST", "/me/device-tickets"))}
          poll={async (id) => {
            const s = await api<{ used: boolean; deviceLabel: string | null; expired: boolean }>("GET", `/me/tickets/${id}`);
            return { used: s.used, who: s.deviceLabel, expired: s.expired };
          }}
          joined={(who) => (
            <>
              <p className="done-mark">{who ?? "新しい端末"}が入りました</p>
              <p>その端末で、続けてパスキーを作ってもらってください。</p>
            </>
          )}
          onClose={() => {
            setAdding(false);
            void reload();
          }}
        />
      )}
    </main>
  );
}

/** この端末で通知を受けるかのオン・オフ。いまの状態（許可済み・拒否・未対応）に合わせて出し分ける */
function PushToggle() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPushState()
      .then(setState)
      .catch(() => setState("unsupported"));
  }, []);

  if (state === null) return null;
  if (state === "needs-home-screen")
    return (
      <p className="notice" data-testid="push-home-screen">
        ホーム画面に追加すると通知を受けられます。共有ボタン → ホーム画面に追加
      </p>
    );
  if (state === "unsupported") return <p className="muted">このブラウザでは通知を受けられません。</p>;

  const toggle = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setState(await (on ? turnOnPush() : turnOffPush()));
    } catch (e) {
      setError(errorText(e));
      setState(await getPushState().catch(() => state));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field">
      <label className="check">
        <input type="checkbox" checked={state === "on"} disabled={busy || state === "denied"} onChange={(e) => void toggle(e.target.checked)} />
        この端末で通知を受ける
      </label>
      {state === "on" && <p className="muted">この端末に、通知の時刻にお知らせが届きます。</p>}
      {state === "denied" && (
        <p className="notice">通知が拒否されています。受けるには、ブラウザ（またはスマホ）の設定で、このサイトの通知を許可してください。</p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
