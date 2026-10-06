import { useCallback, useEffect, useRef, useState } from "react";
import { addDays, diffDays, toDayNum, weekdayOf } from "../../shared/date";
import { WEEKDAYS, shortDate } from "../../shared/describe";
import { type Family, type Me, api } from "../api";
import type { ChoreView, LogView } from "../chores";
import { Fuda, lastText } from "../components/Fuda";
import { errorText } from "../format";
import type { Nav } from "../router";

const UNDO_MS = 6000;

function longDate(d: string) {
  const [, m, day] = d.split("-").map(Number);
  return `${m}月${day}日（${WEEKDAYS[weekdayOf(toDayNum(d))]}）`;
}

/** S1 今日。期限が来ている家事を当番札でいちばん上に。押すと札が裏返り、少しのあいだ取り消せる */
export function Today({ me, family, nav }: { me: Me; family: Family; nav: Nav }) {
  const [data, setData] = useState<{ today: string; chores: ChoreView[] } | null>(null);
  const [done, setDone] = useState<Record<string, LogView>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const load = useCallback(async () => {
    try {
      setData(await api<{ today: string; chores: ChoreView[] }>("GET", `/families/${family.id}/chores`));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [family.id]);

  useEffect(() => {
    setData(null);
    setDone({});
    void load();
  }, [load]);

  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);

  const finish = (choreId: string) => {
    clearTimeout(timers.current[choreId]);
    delete timers.current[choreId];
    setDone(({ [choreId]: _, ...rest }) => rest);
  };

  const markDone = async (chore: ChoreView) => {
    setBusy(chore.id);
    setError(null);
    try {
      const r = await api<{ log: LogView }>("POST", `/chores/${chore.id}/logs`);
      setDone((d) => ({ ...d, [chore.id]: r.log }));
      // 少しのあいだ裏返したまま取り消せるようにし、そのあと並べ直す
      timers.current[chore.id] = setTimeout(async () => {
        await load();
        finish(chore.id);
      }, UNDO_MS);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const undo = async (chore: ChoreView) => {
    const log = done[chore.id];
    if (!log) return;
    setBusy(chore.id);
    try {
      await api("DELETE", `/logs/${log.id}`);
      finish(chore.id);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  if (!data)
    return (
      <main className="page">
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : (
          <p aria-busy="true">読み込んでいます…</p>
        )}
      </main>
    );

  const { today, chores } = data;
  const byDue = (a: ChoreView, b: ChoreView) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999");
  // 期限が来ている：遅れの多い順、次に今日。押した直後の札は並べ直すまでここに残す
  const due = chores.filter((c) => c.status === "overdue" || c.status === "today" || done[c.id]).sort((a, b) => b.daysLate - a.daysLate || byDue(a, b));
  const rest = chores.filter((c) => !due.includes(c)).sort(byDue);
  const soonLimit = addDays(today, 7);
  const soon = rest.filter((c) => c.dueOn && c.dueOn <= soonLimit);
  const later = rest.filter((c) => !soon.includes(c));

  return (
    <main className="page today">
      <header className="today__head">
        <p className="today__family">{family.name}の当番表</p>
        <h1 className="today__date">{longDate(today)}</h1>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {chores.length === 0 ? (
        <section className="empty">
          <h2>まだ家事がありません</h2>
          <p>「ゴミ出し 毎週月・木」「エアコンのフィルター 90日ごと」のように、覚えておきたい家事を登録してください。</p>
          <button className="btn btn--primary" onClick={() => nav.go({ name: "chore-new" })}>
            家事を登録する
          </button>
        </section>
      ) : (
        <>
          <section aria-labelledby="t-due">
            <h2 id="t-due" className="today__section">
              やること<span className="count">{due.length}</span>
            </h2>
            {due.length === 0 ? (
              <p className="all-clear">
                今日やることは、ぜんぶ済んでいます。
                {rest[0]?.dueOn && (
                  <>
                    次は {shortDate(rest[0].dueOn)} の「{rest[0].name}」です。
                  </>
                )}
              </p>
            ) : (
              <ul className="fuda-list">
                {due.map((c) => (
                  <Fuda
                    key={c.id}
                    chore={c}
                    today={today}
                    done={done[c.id] ?? null}
                    busy={busy === c.id}
                    onOpen={() => nav.go({ name: "chore", id: c.id })}
                    onDone={() => void markDone(c)}
                    onUndo={() => void undo(c)}
                  />
                ))}
              </ul>
            )}
          </section>

          {soon.length > 0 && (
            <section aria-labelledby="t-soon">
              <h2 id="t-soon" className="today__section">
                近いうち<span className="muted">（7日以内）</span>
              </h2>
              <ChoreRows chores={soon} today={today} nav={nav} />
            </section>
          )}
          {later.length > 0 && (
            <section aria-labelledby="t-later">
              <h2 id="t-later" className="today__section">
                そのあと
              </h2>
              <ChoreRows chores={later} today={today} nav={nav} />
            </section>
          )}
        </>
      )}
      {me.passkeyCount === 0 && (
        <p className="notice">あなたのアカウントには、まだパスキーがありません。「設定」でパスキーを作っておくと、次からすぐにログインできます。</p>
      )}
    </main>
  );
}

/** まだ先の家事の行（札にはしない） */
function ChoreRows({ chores, today, nav }: { chores: ChoreView[]; today: string; nav: Nav }) {
  return (
    <ul className="list rows">
      {chores.map((c) => (
        <li key={c.id} className="list__item">
          <div>
            <p className="list__title">
              <a
                href={`/chores/${c.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  nav.go({ name: "chore", id: c.id });
                }}
              >
                {c.name}
              </a>
            </p>
            <p className="list__meta">
              {c.assigneeName ? `担当 ${c.assigneeName}、` : ""}
              {lastText(c.lastLog)}
            </p>
          </div>
          {c.dueOn && (
            <p className="rows__due">
              <span className="rows__left">あと{diffDays(today, c.dueOn)}日</span>
              <span className="rows__date">{shortDate(c.dueOn)}</span>
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
