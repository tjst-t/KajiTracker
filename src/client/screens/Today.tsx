import { useCallback, useEffect, useRef, useState } from "react";
import { addDays, diffDays, toDayNum, weekdayOf } from "../../shared/date";
import { WEEKDAYS, shortDate } from "../../shared/describe";
import { type Family, type Me, api } from "../api";
import { breakdownText, buzz, kaisaiShown, markKaisai, useMotion } from "../celebrate";
import type { ChoreView, LogView } from "../chores";
import { Fuda, TodoFuda, lastText } from "../components/Fuda";
import { HowtoDialog } from "../components/Howto";
import { KaisaiDialog, KaisaiSeal } from "../components/Kaisai";
import { Progress, useAskDone } from "../components/TodoParts";
import { errorText } from "../format";
import type { Nav } from "../router";
import { type Completed, type TodoView, completeTodo, dateOfIso, undoComplete } from "../todos";

const UNDO_MS = 6000;

function longDate(d: string) {
  const [, m, day] = d.split("-").map(Number);
  return `${m}月${day}日（${WEEKDAYS[weekdayOf(toDayNum(d))]}）`;
}

/** 札・行に並べるもの（家事か TODO） */
type Item = { kind: "chore"; chore: ChoreView } | { kind: "todo"; todo: TodoView };
const itemId = (i: Item) => (i.kind === "chore" ? i.chore.id : i.todo.id);
const dueOfItem = (i: Item) => (i.kind === "chore" ? { dueOn: i.chore.dueOn, daysLate: i.chore.daysLate } : { dueOn: i.todo.dueOn, daysLate: i.todo.daysLate });
const itemName = (i: Item) => (i.kind === "chore" ? i.chore.name : i.todo.title);

type TodayData = { today: string; chores: ChoreView[]; todos: TodoView[]; doneTodos: TodoView[] };

/**
 * 今日の進み具合。済ませたもの（今日の記録と、いま裏返っている札）の人の名前と、まだ残っている「やること」の数。
 * 総数は 残り＋済ませた数（その日の朝の「やること」に、早めに済ませたものも入る）
 */
function tally(data: TodayData, done: Record<string, LogView>, todoDone: Record<string, Completed>) {
  const who = new Map<string, string>();
  for (const c of data.chores) if (c.lastLog?.doneOn === data.today) who.set(c.id, c.lastLog.userName);
  for (const t of data.doneTodos) who.set(t.id, t.doneByName ?? "");
  for (const [id, l] of Object.entries(done)) who.set(id, l.userName);
  for (const [id, c] of Object.entries(todoDone)) who.set(id, c.todo.doneByName ?? "");
  const due = (s: string | null) => s === "overdue" || s === "today";
  const left =
    data.chores.filter((c) => due(c.status) && !who.has(c.id)).length + data.todos.filter((t) => due(t.dueStatus) && !who.has(t.id)).length;
  const names = [...who.values()];
  return { names, done: names.length, left, total: names.length + left };
}

/**
 * S1 今日。期限が来ている家事と TODO を当番札でいちばん上に。押すと札が裏返り、少しのあいだ取り消せる。
 * TODO は札の左上に「TODO」の印、ボタンは「済み」
 */
export function Today({ me, family, nav }: { me: Me; family: Family; nav: Nav }) {
  const [data, setData] = useState<TodayData | null>(null);
  const [done, setDone] = useState<Record<string, LogView>>({});
  const [todoDone, setTodoDone] = useState<Record<string, Completed>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [howto, setHowto] = useState<ChoreView | null>(null);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  /** 皆済の画面（出ているあいだの件数と内訳） */
  const [kaisai, setKaisai] = useState<{ total: number; breakdown: string } | null>(null);
  /** いま済ませたばかりで、全部済んだか確かめる */
  const justDone = useRef(false);
  const { ask, dialog } = useAskDone();

  const load = useCallback(async () => {
    try {
      const [c, t, d] = await Promise.all([
        api<{ today: string; chores: ChoreView[] }>("GET", `/families/${family.id}/chores`),
        api<{ today: string; todos: TodoView[] }>("GET", `/families/${family.id}/todos?status=open`),
        // 今日済ませた TODO（進み具合と皆済の内訳に）。済ませた新しい順なので、多めに引けば今日の分は入る
        api<{ today: string; todos: TodoView[] }>("GET", `/families/${family.id}/todos?status=done&limit=100`),
      ]);
      setData({ ...c, todos: t.todos, doneTodos: d.todos.filter((x) => x.doneAt && dateOfIso(x.doneAt) === c.today) });
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [family.id]);

  useEffect(() => {
    setData(null);
    setDone({});
    setTodoDone({});
    void load();
  }, [load]);

  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);

  const count = data ? tally(data, done, todoDone) : null;
  // 最後の1件を済ませた瞬間に皆済（札が裏返ってすぐ。Family ごとに1日1回）
  useEffect(() => {
    if (!justDone.current || !data || !count) return;
    justDone.current = false;
    if (count.left > 0 || count.total === 0 || kaisaiShown(family.id, data.today)) return;
    markKaisai(family.id, data.today);
    setKaisai({ total: count.done, breakdown: breakdownText(count.names.filter(Boolean)) });
  });

  const finish = (id: string) => {
    clearTimeout(timers.current[id]);
    delete timers.current[id];
    setDone(({ [id]: _, ...rest }) => rest);
    setTodoDone(({ [id]: _, ...rest }) => rest);
  };

  const markDone = async (chore: ChoreView) => {
    setBusy(chore.id);
    setError(null);
    try {
      const r = await api<{ log: LogView }>("POST", `/chores/${chore.id}/logs`);
      setDone((d) => ({ ...d, [chore.id]: r.log }));
      buzz(12);
      justDone.current = true;
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

  const markTodoDone = async (todo: TodoView) => {
    const all = await ask(todo);
    if (all === null) return;
    setBusy(todo.id);
    setError(null);
    try {
      const c = await completeTodo(todo, all);
      setTodoDone((d) => ({ ...d, [todo.id]: c }));
      buzz(12);
      justDone.current = true;
      timers.current[todo.id] = setTimeout(async () => {
        await load();
        finish(todo.id);
      }, UNDO_MS);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const undoTodo = async (todo: TodoView) => {
    const c = todoDone[todo.id];
    if (!c) return;
    setBusy(todo.id);
    try {
      await undoComplete(c);
      finish(todo.id);
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

  const { today, chores, todos } = data;
  // 家事と TODO を同じ決まりで並べる（同じ並びなら家事が先）
  const items: Item[] = [...chores.map((chore) => ({ kind: "chore" as const, chore })), ...todos.map((todo) => ({ kind: "todo" as const, todo }))];
  const byDue = (a: Item, b: Item) => (dueOfItem(a).dueOn ?? "9999").localeCompare(dueOfItem(b).dueOn ?? "9999");
  const isDue = (i: Item) =>
    i.kind === "chore"
      ? i.chore.status === "overdue" || i.chore.status === "today" || !!done[i.chore.id]
      : i.todo.dueStatus === "overdue" || i.todo.dueStatus === "today" || !!todoDone[i.todo.id];
  // 期限が来ている：遅れの多い順、次に今日。押した直後の札は並べ直すまでここに残す
  const due = items.filter(isDue).sort((a, b) => dueOfItem(b).daysLate - dueOfItem(a).daysLate || byDue(a, b));
  const rest = items.filter((i) => !isDue(i) && (i.kind === "chore" || i.todo.dueOn)).sort(byDue);
  const soonLimit = addDays(today, 7);
  const soon = rest.filter((i) => {
    const d = dueOfItem(i).dueOn;
    return d && d <= soonLimit;
  });
  // そのあと（7日より先）は家事だけ。期限の遠い TODO は TODO の一覧で見る
  const later = rest.filter((i) => !soon.includes(i) && i.kind === "chore");

  const next = rest[0];
  // 今日なにか済ませて、やることが残っていなければ、小さな皆済の判子を静かに
  const kaisaiQuiet = !!count && count.done > 0;
  const dueSection = (
    <section aria-labelledby="t-due">
      <h2 id="t-due" className="today__section">
        やること<span className="count">{due.length}</span>
        {count && count.total > 0 && <DayProgress done={count.done} total={count.total} />}
      </h2>
      {due.length === 0 ? (
        <p className={`all-clear${kaisaiQuiet ? " all-clear--kaisai" : ""}`}>
          {kaisaiQuiet && <KaisaiSeal className="all-clear__seal" />}
          <span>
            {kaisaiQuiet ? "今日の当番は、ぜんぶ済みました。" : "今日やることは、ぜんぶ済んでいます。"}
            {next && dueOfItem(next).dueOn && (
              <>
                次は {shortDate(dueOfItem(next).dueOn!)} の「{itemName(next)}」です。
              </>
            )}
          </span>
        </p>
      ) : (
        <ul className="fuda-list">
          {due.map((i) =>
            i.kind === "chore" ? (
              <Fuda
                key={i.chore.id}
                chore={i.chore}
                today={today}
                done={done[i.chore.id] ?? null}
                busy={busy === i.chore.id}
                onOpen={() => nav.go({ name: "chore", id: i.chore.id })}
                onDone={() => void markDone(i.chore)}
                onUndo={() => void undo(i.chore)}
                onHowto={i.chore.hasHowto ? () => setHowto(i.chore) : undefined}
              />
            ) : (
              <TodoFuda
                key={i.todo.id}
                todo={i.todo}
                today={today}
                done={todoDone[i.todo.id]?.todo ?? null}
                busy={busy === i.todo.id}
                onOpen={() => nav.go({ name: "todo", id: i.todo.id })}
                onDone={() => void markTodoDone(i.todo)}
                onUndo={() => void undoTodo(i.todo)}
              />
            ),
          )}
        </ul>
      )}
    </section>
  );

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

      {chores.length === 0 && (
        <>
          {due.length > 0 && dueSection}
          <section className="empty">
            <h2>まだ家事がありません</h2>
            <p>「ゴミ出し 毎週月・木」「エアコンのフィルター 90日ごと」のように、覚えておきたい家事を登録してください。</p>
            <div className="form-actions">
              <button className="btn btn--primary" onClick={() => nav.go({ name: "chore-new" })}>
                家事を登録する
              </button>
              <button className="btn" onClick={() => nav.go({ name: "chore-table" })}>
                表でまとめて登録
              </button>
            </div>
          </section>
        </>
      )}
      {chores.length > 0 && dueSection}
      {soon.length > 0 && (
        <section aria-labelledby="t-soon">
          <h2 id="t-soon" className="today__section">
            近いうち<span className="muted">（7日以内）</span>
          </h2>
          <ItemRows items={soon} today={today} nav={nav} />
        </section>
      )}
      {later.length > 0 && (
        <section aria-labelledby="t-later">
          <h2 id="t-later" className="today__section">
            そのあと
          </h2>
          <ItemRows items={later} today={today} nav={nav} />
        </section>
      )}
      {howto && <HowtoDialog chore={howto} onClose={() => setHowto(null)} />}
      {kaisai && <KaisaiDialog total={kaisai.total} breakdown={kaisai.breakdown} onClose={() => setKaisai(null)} />}
      {dialog}
      {me.passkeyCount === 0 && (
        <p className="notice">あなたのアカウントには、まだパスキーがありません。「設定」でパスキーを作っておくと、次からすぐにログインできます。</p>
      )}
    </main>
  );
}

/** 見出しの横の「今日 3/5」と細い棒。済んだ数が増えたら、数字が1つ上がる動き */
function DayProgress({ done, total }: { done: number; total: number }) {
  const motion = useMotion();
  const prev = useRef(done);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    if (done > prev.current) setBump((b) => b + 1);
    prev.current = done;
  }, [done]);
  return (
    <span className={`day-progress${done === total ? " is-full" : ""}`} role="img" aria-label={`今日 ${done}/${total} 済み`}>
      <span className="day-progress__num" aria-hidden="true">
        今日{" "}
        <b key={bump} className={bump && motion ? "is-bumping" : undefined}>
          {done}
        </b>
        /{total}
      </span>
      <span className="day-progress__track" aria-hidden="true">
        <span className="day-progress__bar" style={{ transform: `scaleX(${done / total})` }} />
      </span>
    </span>
  );
}

/** まだ先の家事と TODO の行（札にはしない）。TODO には印と進み具合 */
function ItemRows({ items, today, nav }: { items: Item[]; today: string; nav: Nav }) {
  return (
    <ul className="list rows">
      {items.map((i) => {
        const dueOn = dueOfItem(i).dueOn;
        const to = i.kind === "chore" ? ({ name: "chore", id: i.chore.id } as const) : ({ name: "todo", id: i.todo.id } as const);
        const groupName = i.kind === "chore" ? i.chore.groupName : i.todo.groupName;
        const assigneeName = i.kind === "chore" ? i.chore.assigneeName : i.todo.assigneeName;
        return (
          <li key={itemId(i)} className="list__item">
            <div>
              <p className="list__title">
                {i.kind === "todo" && <span className="kind-tag">TODO</span>}
                <a
                  href={i.kind === "chore" ? `/chores/${i.chore.id}` : `/todos/${i.todo.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    nav.go(to);
                  }}
                >
                  {itemName(i)}
                </a>
              </p>
              <p className="list__meta">
                {groupName ? `${groupName}、` : ""}
                {assigneeName ? `担当 ${assigneeName}` : ""}
                {i.kind === "chore" ? `${assigneeName ? "、" : ""}${lastText(i.chore.lastLog)}` : <Progress {...i.todo.progress} />}
              </p>
            </div>
            {dueOn && (
              <p className="rows__due">
                <span className="rows__left">あと{diffDays(today, dueOn)}日</span>
                <span className="rows__date">{shortDate(dueOn)}</span>
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
