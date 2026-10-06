import { useCallback, useEffect, useState } from "react";
import { type Me, type PasskeyItem, type SessionItem, type SessionVia, api } from "../api";
import { registerPasskey, withStepUp } from "../auth";
import { AddDeviceDialog } from "../components/AddDeviceDialog";
import { errorText, formatDateTime } from "../format";

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
        <AddDeviceDialog
          onClose={() => {
            setAdding(false);
            void reload();
          }}
        />
      )}
    </main>
  );
}
