import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { withStepUp } from "../auth";
import { errorText } from "../format";

type Ticket = { id: string; url: string; expiresAt: string };
type Status = { used: boolean; deviceLabel: string | null; expired: boolean };

/** 端末を追加：QR とリンク（同じ札）を出し、使われたら知らせる。札は10分・1回だけ */
export function AddDeviceDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);

  const issue = async () => {
    setError(null);
    setStatus(null);
    setTicket(null);
    try {
      const t = await withStepUp(() => api<Ticket>("POST", "/me/device-tickets"));
      setTicket(t);
      setQr(await QRCode.toDataURL(t.url, { margin: 1, width: 480, color: { dark: "#22302c", light: "#ffffff" } }));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const started = useRef(false);
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
    if (started.current) return; // 開発時の二重実行で札を2枚出さない
    started.current = true;
    void issue();
  }, []);

  // 使われたかを数秒ごとに問い合わせる（Workers で常時接続を持たないため）
  useEffect(() => {
    if (!ticket || status?.used || status?.expired) return;
    const timer = setInterval(async () => {
      setNow(Date.now());
      try {
        setStatus(await api<Status>("GET", `/me/device-tickets/${ticket.id}`));
      } catch {
        /* 次の問い合わせでまた試す */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [ticket, status]);

  const left = ticket ? Math.max(0, Math.floor((new Date(ticket.expiresAt).getTime() - now) / 1000)) : 0;
  const expired = status?.expired || (ticket !== null && left === 0 && !status?.used);

  return (
    <dialog ref={dialog} className="dialog" onClose={onClose} aria-labelledby="add-device-title">
      <h2 id="add-device-title">端末を追加</h2>

      {error && (
        <>
          <p className="error" role="alert">
            {error}
          </p>
          <button className="btn" onClick={() => void issue()}>
            もう一度出す
          </button>
        </>
      )}

      {status?.used ? (
        <div className="stack" role="status">
          <p className="done-mark">{status.deviceLabel ?? "新しい端末"}が入りました</p>
          <p>その端末で、続けてパスキーを作ってもらってください。</p>
        </div>
      ) : expired ? (
        <div className="stack">
          <p>期限（10分）が切れました。</p>
          <button className="btn" onClick={() => void issue()}>
            新しい QR を出す
          </button>
        </div>
      ) : ticket && qr ? (
        <div className="stack">
          <p>新しい端末のカメラで読み取ってください。PC にはリンクを送っても入れます。</p>
          <img className="qr" src={qr} alt="端末を追加するための QR コード" width={240} height={240} />
          <div className="copy-row">
            <input readOnly value={ticket.url} aria-label="端末を追加するためのリンク" onFocus={(e) => e.currentTarget.select()} />
            <button
              className="btn"
              onClick={async () => {
                await navigator.clipboard.writeText(ticket.url);
                setCopied(true);
              }}
            >
              {copied ? "コピーしました" : "リンクをコピー"}
            </button>
          </div>
          <p className="muted">
            残り {Math.floor(left / 60)}分{String(left % 60).padStart(2, "0")}秒。1回使うと終わりです。このリンクは家族にも送らないでください（あなたとして入れてしまいます）。
          </p>
        </div>
      ) : (
        !error && <p aria-busy="true">QR を用意しています…</p>
      )}

      <button className="btn btn--quiet" onClick={() => dialog.current?.close()}>
        閉じる
      </button>
    </dialog>
  );
}
