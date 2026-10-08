import { useCallback, useEffect, useState } from "react";
import { describeSchedule, shortDate } from "../../shared/describe";
import { type Family, type Group, api } from "../api";
import type { ChoreView } from "../chores";
import { Hanko } from "../components/Fuda";
import { errorText } from "../format";
import type { Nav } from "../router";
import { useWide } from "./ChoreBulk";

const NONE = "__none__";

/** S4 家事の一覧。グループごとに見出しを立てる。PC では表、スマホでは行 */
export function Chores({ family, nav }: { family: Family; nav: Nav }) {
  const [data, setData] = useState<{ today: string; chores: ChoreView[] } | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [filter, setFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wide = useWide();
  // まとめて登録・表で直すから戻ってきたときの知らせ
  const [flash] = useState(() => {
    const f = sessionStorage.getItem("kaji.flash");
    sessionStorage.removeItem("kaji.flash");
    return f;
  });

  const load = useCallback(async () => {
    try {
      const [d, g] = await Promise.all([
        api<{ today: string; chores: ChoreView[] }>("GET", `/families/${family.id}/chores${showArchived ? "?archived=1" : ""}`),
        api<Group[]>("GET", `/families/${family.id}/groups`),
      ]);
      setData(d);
      setGroups(g);
    } catch (e) {
      setError(errorText(e));
    }
  }, [family.id, showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = (data?.chores ?? []).slice().sort((a, b) => Number(a.archived) - Number(b.archived) || (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999"));
  // グループの並び順で見出しを立て、グループ無しは最後
  const sections = [...groups.map((g) => ({ key: g.id, name: g.name })), { key: NONE, name: "グループなし" }]
    .filter((s) => !filter || filter === s.key)
    .map((s) => ({ ...s, chores: sorted.filter((c) => (c.groupId ?? NONE) === s.key) }))
    .filter((s) => s.chores.length > 0);

  return (
    <main className="page page--wide">
      <div className="page-head">
        <h1>家事</h1>
        <div className="form-actions">
          {wide && (
            <button className="btn" onClick={() => nav.go({ name: "chore-table" })}>
              表で直す
            </button>
          )}
          <button className="btn" onClick={() => nav.go({ name: "chore-bulk" })}>
            まとめて登録
          </button>
          <button className="btn btn--primary" onClick={() => nav.go({ name: "chore-new" })}>
            家事を登録
          </button>
        </div>
      </div>
      {flash && (
        <p className="notice notice--ok" role="status">
          {flash}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {data && data.chores.length > 0 && (
        <div className="filters">
          <label className="field field--short">
            <span>グループで絞る</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">すべて</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
              <option value={NONE}>グループなし</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            無効の家事も見る
          </label>
        </div>
      )}

      {data && data.chores.length === 0 && (
        <section className="empty">
          <p>まだ家事がありません。「まとめて登録」なら、よくある家事の候補から選んで一度に足せます。</p>
        </section>
      )}
      {data && data.chores.length > 0 && sections.length === 0 && <p className="muted">このグループの家事はありません。</p>}

      {data &&
        sections.map((s) => (
          <section key={s.key} className="group-section" aria-labelledby={`g-${s.key}`}>
            <h2 id={`g-${s.key}`} className="group-heading">
              {s.name}
              <span className="muted">{s.chores.length}</span>
            </h2>
            <table className="chore-table">
              <colgroup>
                <col className="c-name" />
                <col className="c-cycle" />
                <col className="c-due" />
                <col className="c-who" />
                <col className="c-last" />
              </colgroup>
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
                {s.chores.map((c) => (
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
                      {c.archived && <span className="tag">無効</span>}
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
          </section>
        ))}

      <GroupsEditor familyId={family.id} groups={groups} onChanged={load} />
    </main>
  );
}

/** グループの名前を変える・足す・消す・並べ替える */
function GroupsEditor({ familyId, groups, onChanged }: { familyId: string; groups: Group[]; onChanged: () => Promise<void> }) {
  const [names, setNames] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      await onChanged();
      setMessage({ kind: "ok", text: done });
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  /** 隣と入れ替える（並び順をつけ直す） */
  const move = (i: number, dir: -1 | 1) => {
    const order = groups.map((g) => g.id);
    const j = i + dir;
    [order[i], order[j]] = [order[j]!, order[i]!];
    return run(() => Promise.all(order.map((id, k) => api("PATCH", `/groups/${id}`, { sortOrder: k }))), "並べ替えました");
  };

  return (
    <details className="section groups-editor">
      <summary>グループを編集</summary>
      {message && (
        <p className={message.kind === "ok" ? "notice notice--ok" : "error"} role={message.kind === "ok" ? "status" : "alert"}>
          {message.text}
        </p>
      )}
      <ul className="list">
        {groups.map((g, i) => {
          const value = names[g.id] ?? g.name;
          return (
            <li key={g.id} className="list__item">
              <form
                className="row-form group-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() => api("PATCH", `/groups/${g.id}`, { name: value }), "名前を変えました");
                }}
              >
                <input value={value} onChange={(e) => setNames({ ...names, [g.id]: e.target.value })} maxLength={20} aria-label={`グループ「${g.name}」の名前`} />
                <button className="btn btn--small" type="submit" disabled={busy || value.trim() === g.name || !value.trim()}>
                  保存
                </button>
              </form>
              <div className="actions">
                <button className="btn btn--small" disabled={busy || i === 0} onClick={() => void move(i, -1)} aria-label={`${g.name}を上へ`}>
                  上へ
                </button>
                <button className="btn btn--small" disabled={busy || i === groups.length - 1} onClick={() => void move(i, 1)} aria-label={`${g.name}を下へ`}>
                  下へ
                </button>
                <button
                  className="btn btn--danger-quiet"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`グループ「${g.name}」を消しますか？ 入っている家事は消えず、グループなしになります。`))
                      void run(() => api("DELETE", `/groups/${g.id}`), `「${g.name}」を消しました`);
                  }}
                >
                  消す
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <form
        className="row-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("POST", `/families/${familyId}/groups`, { name: newName });
            setNewName("");
          }, "グループを足しました");
        }}
      >
        <label className="field field--short">
          <span>新しいグループ</span>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={20} placeholder="例：庭、車" />
        </label>
        <button className="btn" type="submit" disabled={busy || !newName.trim()}>
          足す
        </button>
      </form>
    </details>
  );
}
