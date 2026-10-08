import { useCallback, useEffect, useState } from "react";
import { describeSchedule, shortDate } from "../../shared/describe";
import { api } from "../api";
import type { ChoreDetail as Detail } from "../chores";
import { Hanko } from "../components/Fuda";
import { HistoryCalendar } from "../components/HistoryCalendar";
import { errorText } from "../format";
import type { Nav } from "../router";

/** S2 家事の詳細：次の期限、記録（取り消し・さかのぼり）、この家事の統計、編集・しまう・消す */
export function ChoreDetail({ id, nav }: { id: string; nav: Nav }) {
  const [c, setC] = useState<Detail | null>(null);
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    const d = await api<Detail>("GET", `/chores/${id}`);
    setC(d);
    setDate((x) => x || d.today);
  }, [id]);

  useEffect(() => {
    load().catch((e) => setMessage({ kind: "error", text: errorText(e) }));
  }, [load]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      await load();
      setMessage({ kind: "ok", text: done });
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!c)
    return (
      <main className="page">
        {message ? (
          <p className="error" role="alert">
            {message.text}
          </p>
        ) : (
          <p aria-busy="true">読み込んでいます…</p>
        )}
      </main>
    );

  const s = c.stats;
  return (
    <main className="page">
      <p className="crumb">
        <a
          href="/chores"
          onClick={(e) => {
            e.preventDefault();
            nav.go({ name: "chores" });
          }}
        >
          家事
        </a>
      </p>
      <div className="detail-head">
        <div>
          <h1>{c.name}</h1>
          <p className="detail-sub">
            {describeSchedule(c.schedule)}
            {c.assigneeName ? `、担当 ${c.assigneeName}` : "、担当なし"}
            {c.notifyTime ? `、通知 ${c.notifyTime}` : ""}
            {c.archived && "（しまってあります）"}
          </p>
        </div>
        {!c.archived && <Hanko chore={c} today={c.today} />}
      </div>

      {message && (
        <p className={message.kind === "ok" ? "notice notice--ok" : "error"} role={message.kind === "ok" ? "status" : "alert"}>
          {message.text}
        </p>
      )}

      {!c.archived && c.dueOn && (
        <p className="next-due">
          次の期限 <b>{shortDate(c.dueOn)}</b>
        </p>
      )}

      {!c.archived && (
        <section className="section" aria-labelledby="d-log">
          <h2 id="d-log">記録する</h2>
          <form
            className="row-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api("POST", `/chores/${c.id}/logs`, { doneOn: date }), `${shortDate(date)} に記録しました`);
            }}
          >
            <label className="field field--short">
              <span>やった日（付け忘れはさかのぼって入れられます）</span>
              <input type="date" value={date} max={c.today} onChange={(e) => setDate(e.target.value)} required />
            </label>
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {date === c.today ? "今日やった" : `${shortDate(date)}にやった`}
            </button>
          </form>
        </section>
      )}

      <section className="section" aria-labelledby="d-history">
        <h2 id="d-history">これまで</h2>
        {(c.logs.length > 0 || c.cycles.length > 0) && (
          <HistoryCalendar logs={c.logs} cycles={c.cycles} dueOn={c.archived ? null : c.dueOn} overdue={c.status === "overdue"} today={c.today} />
        )}
        {c.logs.length === 0 ? (
          <p className="muted">まだ記録がありません。</p>
        ) : (
          <ul className="list" aria-label="記録の一覧">
            {c.logs.map((l) => (
              <li key={l.id} className="list__item">
                <p className="list__title">
                  {shortDate(l.doneOn)} <span className="muted">{l.userName}</span>
                </p>
                <button
                  className="btn btn--danger-quiet"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`${shortDate(l.doneOn)} の記録を取り消しますか？`)) void run(() => api("DELETE", `/logs/${l.id}`), "記録を取り消しました");
                  }}
                >
                  取り消す
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {s.doneCount > 0 && (
        <section className="section" aria-labelledby="d-stats">
          <h2 id="d-stats">この家事の様子</h2>
          <dl className="facts">
            <div>
              <dt>やった回数</dt>
              <dd>{s.doneCount}回</dd>
            </div>
            {s.onTimeRate !== null && (
              <div>
                <dt>期限までにできた</dt>
                <dd>{s.onTimeRate}%</dd>
              </div>
            )}
            {s.averageDaysLate !== null && (
              <div>
                <dt>平均の遅れ</dt>
                <dd>{s.averageDaysLate}日</dd>
              </div>
            )}
            {s.missedCount > 0 && (
              <div>
                <dt>やらずに過ぎた回</dt>
                <dd>{s.missedCount}回</dd>
              </div>
            )}
            {s.averageInterval !== null && (
              <div>
                <dt>実際の間隔</dt>
                <dd>
                  平均 {s.averageInterval}日{s.plannedInterval && <small className="facts__note">決めた周期は {s.plannedInterval}日</small>}
                </dd>
              </div>
            )}
          </dl>
        </section>
      )}

      <section className="section">
        <div className="form-actions">
          <button className="btn" onClick={() => nav.go({ name: "chore-edit", id: c.id })}>
            編集
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() => void run(() => api("PATCH", `/chores/${c.id}`, { archived: !c.archived }), c.archived ? "元に戻しました" : "しまいました。一覧と通知から外れます")}
          >
            {c.archived ? "元に戻す" : "しまう"}
          </button>
          <button
            className="btn btn--danger-quiet"
            disabled={busy}
            onClick={async () => {
              if (!confirm(`「${c.name}」を消しますか？ 記録もすべて消え、元に戻せません。季節ものなどは「しまう」を使うと記録が残ります。`)) return;
              try {
                await api("DELETE", `/chores/${c.id}`);
                nav.go({ name: "chores" });
              } catch (e) {
                setMessage({ kind: "error", text: errorText(e) });
              }
            }}
          >
            消す
          </button>
        </div>
      </section>
    </main>
  );
}
