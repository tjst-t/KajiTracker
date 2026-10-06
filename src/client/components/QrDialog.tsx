import QRCode from "qrcode";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { errorText } from "../format";

export type IssuedQr = { id: string; url: string; expiresAt: string };
export type QrStatus = { used: boolean; who: string | null; expired: boolean };

/**
 * QR とリンク（中身は同じ）を出し、使われたら知らせるダイアログ。
 * 端末を追加・回復の札・家族の招待で使う。使われたかは数秒ごとに問い合わせる（Workers で常時接続を持たないため）
 */
export function QrDialog(props: {
  title: string;
  intro: ReactNode;
  caution: ReactNode;
  issue: () => Promise<IssuedQr>;
  poll: (id: string) => Promise<QrStatus>;
  joined: (who: string | null) => ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [qr, setQr] = useState<{ ticket: IssuedQr; image: string } | null>(null);
  const [status, setStatus] = useState<QrStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);

  const issue = async () => {
    setError(null);
    setStatus(null);
    setQr(null);
    setCopied(false);
    try {
      const ticket = await props.issue();
      const image = await QRCode.toDataURL(ticket.url, { margin: 1, width: 480, color: { dark: "#22302c", light: "#ffffff" } });
      setQr({ ticket, image });
      setNow(Date.now());
    } catch (e) {
      setError(errorText(e));
    }
  };

  const started = useRef(false);
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
    if (started.current) return; // 開発時の二重実行で2枚出さない
    started.current = true;
    void issue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!qr || status?.used || status?.expired) return;
    const timer = setInterval(async () => {
      setNow(Date.now());
      try {
        setStatus(await props.poll(qr.ticket.id));
      } catch {
        /* 次の問い合わせでまた試す */
      }
    }, 2000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qr, status]);

  const left = qr ? Math.max(0, Math.floor((new Date(qr.ticket.expiresAt).getTime() - now) / 1000)) : 0;
  const expired = status?.expired || (qr !== null && left === 0 && !status?.used);

  return (
    <dialog ref={dialog} className="dialog" onClose={props.onClose} aria-labelledby="qr-dialog-title">
      <h2 id="qr-dialog-title">{props.title}</h2>

      {error && (
        <div className="stack">
          <p className="error" role="alert">
            {error}
          </p>
          <button className="btn" onClick={() => void issue()}>
            もう一度出す
          </button>
        </div>
      )}

      {status?.used ? (
        <div className="stack" role="status">
          {props.joined(status.who)}
        </div>
      ) : expired ? (
        <div className="stack">
          <p>期限が切れました。</p>
          <button className="btn" onClick={() => void issue()}>
            新しい QR を出す
          </button>
        </div>
      ) : qr ? (
        <div className="stack">
          <p>{props.intro}</p>
          <img className="qr" src={qr.image} alt={`${props.title}の QR コード`} width={240} height={240} />
          <div className="copy-row">
            <input readOnly value={qr.ticket.url} aria-label={`${props.title}のリンク`} onFocus={(e) => e.currentTarget.select()} />
            <button
              className="btn"
              onClick={async () => {
                await navigator.clipboard.writeText(qr.ticket.url);
                setCopied(true);
              }}
            >
              {copied ? "コピーしました" : "リンクをコピー"}
            </button>
          </div>
          <p className="muted">
            残り {formatLeft(left)}。{props.caution}
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

function formatLeft(sec: number): string {
  if (sec >= 3600) return `${Math.floor(sec / 3600)}時間${Math.floor((sec % 3600) / 60)}分`;
  return `${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, "0")}秒`;
}
