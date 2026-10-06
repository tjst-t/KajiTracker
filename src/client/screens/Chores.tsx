import { useEffect, useState } from "react";
import { describeSchedule, shortDate } from "../../shared/describe";
import { type Family, api } from "../api";
import type { ChoreView } from "../chores";
import { Hanko } from "../components/Fuda";
import { errorText } from "../format";
import type { Nav } from "../router";

/** S4 家事の一覧。PC では表、スマホでは行 */
export function Chores({ family, nav }: { family: Family; nav: Nav }) {
  const [data, setData] = useState<{ today: string; chores: ChoreView[] } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ today: string; chores: ChoreView[] }>("GET", `/families/${family.id}/chores${showArchived ? "?archived=1" : ""}`)
      .then(setData)
      .catch((e) => setError(errorText(e)));
  }, [family.id, showArchived]);

  const rows = (data?.chores ?? []).slice().sort((a, b) => Number(a.archived) - Number(b.archived) || (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999"));

  return (
    <main className="page page--wide">
      <div className="page-head">
        <h1>家事</h1>
        <button className="btn btn--primary" onClick={() => nav.go({ name: "chore-new" })}>
          家事を登録
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data && rows.length === 0 && <p>まだ家事がありません。「家事を登録」から足してください。</p>}
      {rows.length > 0 && data && (
        <table className="chore-table">
          <thead>
            <tr>
              <th scope="col">家事</th>
              <th scope="col">周期</th>
              <th scope="col">次の期限</th>
              <th scope="col">担当</th>
              <th scope="col">前回</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className={c.archived ? "is-archived" : ""}>
                <th scope="row">
                  <a
                    href={`/chores/${c.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      nav.go({ name: "chore", id: c.id });
                    }}
                  >
                    {c.name}
                  </a>
                  {c.archived && <span className="tag">しまってある</span>}
                </th>
                <td data-label="周期">{describeSchedule(c.schedule)}</td>
                <td data-label="次の期限">
                  {c.archived || !c.dueOn ? (
                    "—"
                  ) : (
                    <span className="due-cell">
                      {shortDate(c.dueOn)}
                      <Hanko chore={c} today={data.today} />
                    </span>
                  )}
                </td>
                <td data-label="担当">{c.assigneeName ?? "なし"}</td>
                <td data-label="前回">{c.lastLog ? `${shortDate(c.lastLog.doneOn)} ${c.lastLog.userName}` : "まだ"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <label className="check">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        しまった家事も見る
      </label>
    </main>
  );
}
