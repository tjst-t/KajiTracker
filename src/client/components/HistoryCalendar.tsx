import { useState } from "react";
import { type DateStr, daysInMonth, toDayNum, weekdayOf } from "../../shared/date";
import { WEEKDAYS } from "../../shared/describe";
import type { Cycle } from "../../shared/schedule";
import type { LogView } from "../chores";

/** 予定日の印。ontime＝期限内に済んだ、late＝遅れて済んだ（または遅れている）、missed＝やらずに過ぎた、next＝次の期限 */
type DueMark = "ontime" | "late" | "missed" | "next";

const DUE_TEXT: Record<DueMark, string> = {
  ontime: "予定日（期限内にできた）",
  late: "予定日（遅れた）",
  missed: "予定日（やらずに過ぎた）",
  next: "次の期限",
};

const MONTHS_STEP = 3;

type Props = { logs: LogView[]; cycles: Cycle[]; dueOn: DateStr | null; overdue: boolean; today: DateStr };

/** 実施履歴のカレンダー。新しい月から並べ、やった日に若竹の印、予定日に輪（遅れ・やらずに過ぎた回は朱） */
export function HistoryCalendar({ logs, cycles, dueOn, overdue, today }: Props) {
  const [shown, setShown] = useState(MONTHS_STEP);

  const done = new Map<DateStr, string[]>();
  for (const l of logs) done.set(l.doneOn, [...(done.get(l.doneOn) ?? []), l.userName]);
  const due = new Map<DateStr, DueMark>();
  for (const c of cycles) due.set(c.dueOn, c.missed ? "missed" : c.daysLate ? "late" : "ontime");
  if (dueOn && !due.has(dueOn)) due.set(dueOn, overdue ? "late" : "next");

  // 古い記録・予定日の月から、今日（か次の期限）の月まで
  const dates = [...done.keys(), ...due.keys(), today];
  const first = dates.reduce((a, b) => (a < b ? a : b)).slice(0, 7);
  const last = dates.reduce((a, b) => (a > b ? a : b)).slice(0, 7);
  const months: string[] = [];
  for (let ym = last; ym >= first; ym = prevMonth(ym)) months.push(ym);

  return (
    <div className="hcal">
      <ul className="hcal__legend" aria-label="印の見方">
        <li>
          <span className="hcal__day is-done" aria-hidden="true">
            5
          </span>
          やった日
        </li>
        <li>
          <span className="hcal__day due-ontime" aria-hidden="true">
            5
          </span>
          予定日
        </li>
        <li>
          <span className="hcal__day due-late" aria-hidden="true">
            5
          </span>
          遅れた予定日
        </li>
        <li>
          <span className="hcal__day due-missed" aria-hidden="true">
            5
          </span>
          やらずに過ぎた
        </li>
        <li>
          <span className="hcal__day due-next" aria-hidden="true">
            5
          </span>
          次の期限
        </li>
      </ul>
      <div className="hcal__months">
        {months.slice(0, shown).map((ym) => (
          <Month key={ym} ym={ym} done={done} due={due} today={today} />
        ))}
      </div>
      {months.length > shown && (
        <button className="btn btn--small" onClick={() => setShown((n) => n + MONTHS_STEP)}>
          もっと前の月を見る
        </button>
      )}
    </div>
  );
}

function prevMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

function Month({ ym, done, due, today }: { ym: string; done: Map<DateStr, string[]>; due: Map<DateStr, DueMark>; today: DateStr }) {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const dim = daysInMonth(y, m);
  const lead = weekdayOf(toDayNum(`${ym}-01`)); // 日曜始まり
  const cells: (number | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: dim }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
  const doneDays = [...done.keys()].filter((d) => d.startsWith(ym)).length;

  return (
    <table className="hcal__month">
      <caption>
        {y}年{m}月<span className="muted"> {doneDays}日やった</span>
      </caption>
      <thead>
        <tr>
          {WEEKDAYS.map((w) => (
            <th key={w} scope="col" abbr={`${w}曜`}>
              {w}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week, i) => (
          <tr key={i}>
            {week.map((d, j) => {
              if (d === null) return <td key={j} />;
              const date = `${ym}-${String(d).padStart(2, "0")}`;
              const who = done.get(date);
              const mark = due.get(date);
              const notes = [who && `やった（${who.join("・")}）`, mark && DUE_TEXT[mark], date === today && "今日"].filter(Boolean);
              const cls = ["hcal__day", who && "is-done", mark && `due-${mark}`, date === today && "is-today"].filter(Boolean).join(" ");
              return (
                <td key={j}>
                  <span className={cls} title={notes.join("・") || undefined}>
                    {d}
                    {notes.length > 0 && <span className="visually-hidden">日 {notes.join("・")}</span>}
                  </span>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
