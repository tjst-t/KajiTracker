import { useCallback, useEffect, useState } from "react";
import { type Family, type Me, type Member, api } from "../api";
import { withStepUp } from "../auth";
import { type IssuedQr, QrDialog } from "../components/QrDialog";
import { errorText } from "../format";
import { FamilyCreateForm } from "./FamilyCreate";

type Dialog = { kind: "invite" } | { kind: "recovery"; member: Member } | null;

/** S6 Family：メンバーと役割、招待、回復の札、抜ける・外す、名前の変更、削除。S7 の「新しく作る」もここに置く */
export function FamilyScreen(props: { me: Me; family: Family; onFamiliesChanged: (select?: string) => Promise<void> }) {
  const { family } = props;
  const isAdmin = family.role === "admin";
  const [members, setMembers] = useState<Member[]>([]);
  const [rename, setRename] = useState(family.name);
  const [confirmName, setConfirmName] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const reload = useCallback(async () => {
    setMembers(await api<Member[]>("GET", `/families/${family.id}/members`));
  }, [family.id]);

  useEffect(() => {
    setRename(family.name);
    setConfirmName("");
    setMessage(null);
    reload().catch((e) => setMessage({ kind: "error", text: errorText(e) }));
  }, [family.id, family.name, reload]);

  const run = async (fn: () => Promise<unknown>, done: string, after?: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (after) await after();
      else await reload();
      setMessage({ kind: "ok", text: done });
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const adminCount = members.filter((m) => m.role === "admin").length;

  return (
    <main className="page">
      <h1>{family.name}</h1>
      {message && (
        <p className={message.kind === "ok" ? "notice notice--ok" : "error"} role={message.kind === "ok" ? "status" : "alert"}>
          {message.text}
        </p>
      )}

      <section className="section" aria-labelledby="f-members">
        <h2 id="f-members">家族</h2>
        <ul className="list">
          {members.map((m) => (
            <li key={m.userId} className="list__item list__item--stacked">
              <div>
                <p className="list__title">
                  {m.displayName}
                  {m.role === "admin" && <span className="tag">管理者</span>}
                  {m.isMe && <span className="tag">あなた</span>}
                </p>
              </div>
              <div className="actions">
                {isAdmin && !m.isMe && (
                  <>
                    {m.role === "member" ? (
                      <button
                        className="btn btn--small"
                        disabled={busy}
                        onClick={() => void run(() => api("PATCH", `/families/${family.id}/members/${m.userId}`, { role: "admin" }), `${m.displayName}さんを管理者にしました`)}
                      >
                        管理者にする
                      </button>
                    ) : (
                      <button
                        className="btn btn--small"
                        disabled={busy}
                        onClick={() => void run(() => api("PATCH", `/families/${family.id}/members/${m.userId}`, { role: "member" }), `${m.displayName}さんをメンバーに戻しました`)}
                      >
                        メンバーに戻す
                      </button>
                    )}
                    <button className="btn btn--small" disabled={busy} onClick={() => setDialog({ kind: "recovery", member: m })}>
                      ログインできなくなったとき
                    </button>
                    <button
                      className="btn btn--danger-quiet"
                      disabled={busy}
                      onClick={() => {
                        if (confirm(`${m.displayName}さんを「${family.name}」から外しますか？ これまでの記録は残ります。`))
                          void run(() => api("DELETE", `/families/${family.id}/members/${m.userId}`), `${m.displayName}さんを外しました`);
                      }}
                    >
                      外す
                    </button>
                  </>
                )}
                {isAdmin && m.isMe && m.role === "admin" && adminCount > 1 && (
                  <button
                    className="btn btn--small"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => api("PATCH", `/families/${family.id}/members/${m.userId}`, { role: "member" }),
                        "あなたはメンバーになりました",
                        () => props.onFamiliesChanged(family.id),
                      )
                    }
                  >
                    メンバーに戻る
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {isAdmin ? (
          <>
            <button className="btn btn--primary" disabled={busy} onClick={() => setDialog({ kind: "invite" })}>
              家族を招待
            </button>
            <p className="muted">招待の QR を家族のスマホで読み取ってもらいます。QR は24時間・1人だけ使えます。</p>
            {members.length > 1 && adminCount === 1 && (
              <p className="muted">管理者が2人いると、どちらかがスマホをなくしても、もう1人がログインの札を出せます。</p>
            )}
          </>
        ) : (
          <p className="muted">家族を招待するには、管理者に頼んでください。</p>
        )}
      </section>

      {isAdmin && (
        <section className="section" aria-labelledby="f-name">
          <h2 id="f-name">名前</h2>
          <form
            className="row-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api("PATCH", `/families/${family.id}`, { name: rename.trim() }), "名前を変えました", () => props.onFamiliesChanged(family.id));
            }}
          >
            <label className="field">
              <span>Family の名前</span>
              <input value={rename} onChange={(e) => setRename(e.target.value)} maxLength={30} required />
            </label>
            <button className="btn" type="submit" disabled={busy || rename.trim() === family.name}>
              名前を保存
            </button>
          </form>
        </section>
      )}

      <section className="section" aria-labelledby="f-new">
        <h2 id="f-new">ほかの Family</h2>
        <p className="muted">実家の家事なども分けて管理できます。上の切り替えで行き来します。</p>
        <FamilyCreateForm compact onCreated={(f) => void props.onFamiliesChanged(f.id)} />
      </section>

      <section className="section" aria-labelledby="f-leave">
        <h2 id="f-leave">抜ける・削除</h2>
        <button
          className="btn btn--danger-quiet btn--inline"
          disabled={busy}
          onClick={() => {
            const alone = members.length <= 1;
            const text = alone
              ? `あなたしかいないので、抜けると「${family.name}」は家事と記録ごと削除されます。抜けますか？`
              : `「${family.name}」から抜けますか？ これまでの記録は残ります。`;
            if (confirm(text))
              void run(
                () => api("DELETE", `/families/${family.id}/members/${props.me.user.id}`),
                `「${family.name}」から抜けました`,
                () => props.onFamiliesChanged(),
              );
          }}
        >
          「{family.name}」から抜ける
        </button>
        {isAdmin && adminCount === 1 && members.length > 1 && <p className="muted">最後の管理者は抜けられません。先にほかの人を管理者にしてください。</p>}

        {isAdmin && (
          <form
            className="danger-zone"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () => withStepUp(() => api("DELETE", `/families/${family.id}`, { confirmName: confirmName.trim() })),
                `「${family.name}」を削除しました`,
                () => props.onFamiliesChanged(),
              );
            }}
          >
            <p>
              Family を削除すると、家事と記録もすべて消え、元に戻せません。確認のため、<span className="nobr">「{family.name}」</span>と入れてください。
            </p>
            <div className="row-form">
              <label className="field">
                <span>Family の名前</span>
                <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
              </label>
              <button className="btn btn--danger" type="submit" disabled={busy || confirmName.trim() !== family.name}>
                Family を削除
              </button>
            </div>
          </form>
        )}
      </section>

      {dialog?.kind === "invite" && (
        <QrDialog
          title="家族を招待"
          intro={`家族のスマホのカメラで読み取ってもらってください。「${family.name}」に入れます。`}
          caution="1人だけ使えます。"
          issue={() => api<IssuedQr>("POST", `/families/${family.id}/invites`)}
          poll={async (id) => {
            const s = await api<{ used: boolean; usedByName: string | null; expired: boolean }>("GET", `/families/${family.id}/invites/${id}`);
            return { used: s.used, who: s.usedByName, expired: s.expired };
          }}
          joined={(who) => <p className="done-mark">{who ?? "家族"}さんが入りました</p>}
          onClose={() => {
            setDialog(null);
            void reload();
          }}
        />
      )}

      {dialog?.kind === "recovery" && (
        <QrDialog
          title={`${dialog.member.displayName}さんのログインの札`}
          intro={`${dialog.member.displayName}さんの新しい端末で読み取ってもらってください。スマホをなくした・パスキーが消えたときに使います。`}
          caution={`1回使うと終わりです。${dialog.member.displayName}さんとして入れる札なので、本人にだけ見せてください。`}
          issue={() => withStepUp(() => api<IssuedQr>("POST", `/families/${family.id}/members/${dialog.member.userId}/recovery-ticket`))}
          poll={async (id) => {
            const s = await api<{ used: boolean; deviceLabel: string | null; expired: boolean }>("GET", `/me/tickets/${id}`);
            return { used: s.used, who: s.deviceLabel, expired: s.expired };
          }}
          joined={(who) => (
            <>
              <p className="done-mark">{who ?? "新しい端末"}で入りました</p>
              <p>その端末で、続けてパスキーを作ってもらってください。</p>
            </>
          )}
          onClose={() => setDialog(null)}
        />
      )}
    </main>
  );
}
