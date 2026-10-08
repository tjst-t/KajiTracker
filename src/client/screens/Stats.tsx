import { useEffect, useState } from "react";
import { type DateStr, todayInTokyo } from "../../shared/date";
import { shortDate } from "../../shared/describe";
import { STATS_MIN_DATE, type Stats, monthRange } from "../../shared/stats";
import { type Family, api } from "../api";
import { errorText } from "../format";

type StatsResponse = Stats & { today: DateStr };

const PERIODS = [
  ["month", "今月"],
  ["3months", "3か月"],
  ["all", "全期間"],
] as const;
type Period = (typeof PERIODS)[number][0];

/** 期間の始めと終わり（日本時間）。3か月は今月を含む3つの月 */
function rangeOf(p: Period, today: DateStr): { from: DateStr; to: DateStr } {
  const month = monthRange(today);
  if (p === "month") return month;
  if (p === "all") return { from: STATS_MIN_DATE, to: month.to };
  const [y, m] = today.split("-").map(Number) as [number, number];
  const back = new Date(Date.UTC(y, m - 1 - 2, 1)).toISOString().slice(0, 10);
  return { from: back, to: month.to };
}

/** 人の見分け：藍の濃淡。色だけに頼らず、名前と数をいつも横に書く */
const PERSON_TONES = ["#2f4f6f", "#6f8fae", "#afc3d6", "#56645f"];
const OTHER_TONE = "#c9d1cb";

/** 週ごとの棒を出す上限（全期間で細くなりすぎないように） */
const WEEKS_SHOWN = 26;

/** S5 統計：期間の切り替え、分担、担当の偏り、守れた率と平均の遅れ、推移、よく遅れる家事 */
export function StatsScreen({ family }: { family: Family }) {
  const [period, setPeriod] = useState<Period>("month");
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const { from, to } = rangeOf(period, todayInTokyo());
    setError(null);
    api<StatsResponse>("GET", `/families/${family.id}/stats?from=${from}&to=${to}`)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [family.id, period]);

  const tone = new Map((data?.people ?? []).map((p, i) => [p.userId, PERSON_TONES[i] ?? OTHER_TONE]));
  const nameOf = new Map((data?.people ?? []).map((p) => [p.userId, p.name]));

  return (
    <main className="page page--wide stats">
      <h1>統計</h1>
      <div className="segmented stats__period" role="tablist" aria-label="期間">
        {PERIODS.map(([p, label]) => (
          <button key={p} role="tab" aria-selected={period === p} onClick={() => setPeriod(p)}>
            {label}
          </button>
        ))}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p aria-busy="true">読み込んでいます…</p>}

      {data && (
        <div aria-busy={false}>
          <p className="stats__range">
            {period === "all" ? `全期間（${shortDate(data.today)}まで）` : `${shortDate(data.from)}〜${shortDate(data.to)}`}
          </p>

          {data.totalCount === 0 && data.punctuality.judgedCount === 0 ? (
            <p className="empty muted">この期間はまだ記録がありません。家事を「やった」にすると、ここに分担や推移が出ます。</p>
          ) : (
            <>
              <section className="section" aria-labelledby="s-share">
                <h2 id="s-share">分担</h2>
                <p className="stats__headline">
                  この期間に <b>{data.totalCount}</b>回
                </p>
                {data.totalCount === 0 ? (
                  <p className="muted">この期間にやった記録はありません。</p>
                ) : (
                  <ul className="hbars">
                    {data.people.map((p) => (
                      <li key={p.userId} className="hbars__row">
                        <span className="hbars__label">
                          <Swatch color={tone.get(p.userId)} />
                          {p.name}
                          {!p.isMember && <span className="tag">抜けた人</span>}
                        </span>
                        <span className="hbars__track" aria-hidden="true">
                          <span className="hbars__bar" style={{ width: `${p.share}%`, background: tone.get(p.userId) }} />
                        </span>
                        <span className="hbars__value">
                          <b>{p.count}</b>回・{p.share}%
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {data.byChore.length > 0 && (
                <section className="section" aria-labelledby="s-bias">
                  <h2 id="s-bias">家事ごとの担当</h2>
                  <p className="muted">だれがどの家事をやっているか。棒の長さは回数の割合です。</p>
                  <ul className="bias">
                    {data.byChore.map((c) => (
                      <li key={c.choreId} className="bias__row">
                        <p className="bias__name">
                          {c.name}
                          {c.archived && <span className="tag">しまった</span>}
                          <span className="muted"> {c.count}回</span>
                        </p>
                        <span className="stack-bar" aria-hidden="true">
                          {c.byUser.map((u) => (
                            <span key={u.userId} style={{ flexGrow: u.count, background: tone.get(u.userId) ?? OTHER_TONE }} title={`${nameOf.get(u.userId) ?? "（不明）"} ${u.count}回`} />
                          ))}
                        </span>
                        <p className="bias__who">
                          {c.byUser.map((u) => (
                            <span key={u.userId}>
                              <Swatch color={tone.get(u.userId) ?? OTHER_TONE} />
                              {nameOf.get(u.userId) ?? "（不明）"} {u.count}回
                            </span>
                          ))}
                        </p>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <Punctuality p={data.punctuality} />

              <Trend data={data} period={period} />

              <section className="section" aria-labelledby="s-late">
                <h2 id="s-late">よく遅れる家事</h2>
                {data.lateRanking.length === 0 ? (
                  <p className="muted">{data.punctuality.judgedCount ? "遅れた家事はありません。" : "期限のある回がまだありません。"}</p>
                ) : (
                  <ol className="ranking">
                    {data.lateRanking.map((c, i) => (
                      <li key={c.choreId} className="ranking__row">
                        <span className="ranking__rank" aria-hidden="true">
                          {i + 1}
                        </span>
                        <div className="ranking__body">
                          <p className="ranking__name">
                            {c.name}
                            {c.archived && <span className="tag">しまった</span>}
                          </p>
                          <span className="hbars__track hbars__track--thin" aria-hidden="true">
                            <span className="hbars__bar hbars__bar--late" style={{ width: `${(c.score / data.lateRanking[0]!.score) * 100}%` }} />
                          </span>
                          <p className="ranking__meta">
                            {c.averageDaysLate !== null && <span>平均 {c.averageDaysLate}日遅れ</span>}
                            {c.missedCount > 0 && <span>やらずに過ぎた {c.missedCount}回</span>}
                            {c.onTimeRate !== null && <span>守れた率 {c.onTimeRate}%</span>}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </main>
  );
}

function Swatch({ color }: { color: string | undefined }) {
  return <span className="swatch" style={{ background: color ?? OTHER_TONE }} aria-hidden="true" />;
}

/** 守れた率：期限内・遅れ・やらずに過ぎた、の3つに分けた帯と数 */
function Punctuality({ p }: { p: Stats["punctuality"] }) {
  const late = p.judgedCount - p.onTimeCount - p.missedCount;
  return (
    <section className="section" aria-labelledby="s-punct">
      <h2 id="s-punct">期限の守り具合</h2>
      {p.judgedCount === 0 ? (
        <p className="muted">この期間に期限の来た回はまだありません。</p>
      ) : (
        <>
          <dl className="facts">
            <div>
              <dt>期限までにできた</dt>
              <dd>
                {p.onTimeRate}%<small className="facts__note">{p.judgedCount}回のうち {p.onTimeCount}回</small>
              </dd>
            </div>
            <div>
              <dt>平均の遅れ</dt>
              <dd>{p.averageDaysLate === null ? "—" : `${p.averageDaysLate}日`}</dd>
            </div>
            <div>
              <dt>やらずに過ぎた</dt>
              <dd>{p.missedCount}回</dd>
            </div>
          </dl>
          <span className="stack-bar stack-bar--punct" aria-hidden="true">
            {p.onTimeCount > 0 && <span className="is-ontime" style={{ flexGrow: p.onTimeCount }} />}
            {late > 0 && <span className="is-late" style={{ flexGrow: late }} />}
            {p.missedCount > 0 && <span className="is-missed" style={{ flexGrow: p.missedCount }} />}
          </span>
          <p className="bias__who">
            <span>
              <span className="swatch is-ontime" aria-hidden="true" />
              期限内 {p.onTimeCount}回
            </span>
            <span>
              <span className="swatch is-late" aria-hidden="true" />
              遅れてやった {late}回
            </span>
            <span>
              <span className="swatch is-missed" aria-hidden="true" />
              やらずに過ぎた {p.missedCount}回
            </span>
          </p>
        </>
      )}
    </section>
  );
}

function Trend({ data, period }: { data: StatsResponse; period: Period }) {
  // まだ来ていない週は出さない
  const all = data.weekly.filter((w) => w.weekStart <= data.today);
  const weekly = all.slice(-WEEKS_SHOWN);
  const monthOf = (i: number) => weekly[i]?.weekStart.slice(5, 7);
  const showMonthly = period !== "month" && data.monthly.length > 1;
  return (
    <section className="section" aria-labelledby="s-trend">
      <h2 id="s-trend">回数の推移</h2>
      {showMonthly && (
        <Columns
          title="月ごと"
          items={data.monthly.map((m) => ({ key: m.month, count: m.count, label: `${Number(m.month.slice(5))}月`, long: `${m.month.slice(0, 4)}年${Number(m.month.slice(5))}月` }))}
        />
      )}
      <Columns
        title={all.length > WEEKS_SHOWN ? `週ごと（直近${WEEKS_SHOWN}週）` : "週ごと"}
        items={weekly.map((w, i) => {
          const md = `${Number(w.weekStart.slice(5, 7))}/${Number(w.weekStart.slice(8))}`;
          // 目盛りは月の最初の週だけ。先頭は、すぐ次で月が変わらなければ付ける（重ならないように）
          const first = i === 0 ? monthOf(1) === monthOf(0) : monthOf(i) !== monthOf(i - 1);
          return { key: w.weekStart, count: w.count, label: first ? md : "", long: `${md}からの週` };
        })}
      />
    </section>
  );
}

/** 縦の棒グラフ。棒の上に数（多いときは最大と最後だけ）、読み上げ用に表も持つ */
function Columns({ title, items }: { title: string; items: { key: string; count: number; label: string; long: string }[] }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  const many = items.length > 14;
  const maxAt = items.findIndex((i) => i.count === max);
  return (
    <figure className="columns">
      <figcaption className="columns__title">{title}</figcaption>
      <ol className="columns__plot" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((it, i) => {
          const showNum = !many || i === maxAt || i === items.length - 1;
          return (
            <li key={it.key} className="columns__col" title={`${it.long} ${it.count}回`}>
              <span className="columns__num">{showNum && it.count > 0 ? it.count : ""}</span>
              <span className={it.count ? "columns__bar" : "columns__bar is-zero"} style={{ height: `${(it.count / max) * 100}%` }} />
              <span className="columns__label">{it.label}</span>
            </li>
          );
        })}
      </ol>
      <table className="visually-hidden">
        <caption>{title}の回数</caption>
        <tbody>
          {items.map((it) => (
            <tr key={it.key}>
              <th scope="row">{it.long}</th>
              <td>{it.count}回</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
