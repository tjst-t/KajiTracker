import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, type Family, type Me, api } from "../api";
import { errorText } from "../format";
import { type FrequentItem, type ShoppingItem, type ShoppingListSummary, type ShoppingListView, type ShoppingOp, applyOps, newItemId } from "../shopping";
import {
  type SyncState,
  cachedView,
  clearDropped,
  flushShopping,
  getSyncState,
  opsToApply,
  markAuthLost,
  markOffline,
  markOnline,
  pushOp,
  saveView,
  subscribeSync,
} from "../shopping-store";

/** 画面を開いている間、読み直す間隔（画面が見えているときだけ） */
const POLL_MS = 5000;
/** 入力が空のときに出す「よく買うもの」の数 */
const CHIPS_MAX = 12;
const NONE = "__none__";

const listKey = (familyId: string) => `kaji.shoppingList.${familyId}`;

/**
 * 買い物メモ。お店ごとのリストを切り替え、売り場ごとに品物を並べる。タップでカゴに入れ、「買い物を終える」で履歴へ。
 * 端末に持った中身（shopping-store）でまず描き、つながっていれば読み直す。変更は端末に積んでから送る
 */
export function Shopping({ me, family, onAuthLost }: { me: Me; family: Family; onAuthLost: () => void }) {
  const [listId, setListId] = useState<string | null>(() => localStorage.getItem(listKey(family.id)));
  /** 最後にサーバから読めた中身（端末に持っていたものを含む）と、読み始めたときの sent */
  const [server, setServer] = useState<{ view: ShoppingListView; readAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const sync = useSyncExternalStore(subscribeSync, getSyncState);
  // 画面に出すのは、読めた中身に、そのあと送れた変更とまだ送っていない変更を重ねたもの
  const data = useMemo(() => (server && sync.ready ? applyOps(server.view, opsToApply(sync, server.readAt)) : null), [server, sync]);
  // リストを切り替えたら、前のリストの読み直しの結果を捨てる
  const gen = useRef(0);
  // 読み直しは、あとから始めたものの結果だけ使う（遅れて返った古い結果で戻さない）
  const reads = useRef(0);
  const applied = useRef(0);
  /** いま出しているリストの id */
  const shown = useRef<string | null>(null);
  shown.current = server?.view.list.id ?? null;
  const prefetched = useRef(false);

  const choose = (id: string) => {
    gen.current++;
    localStorage.setItem(listKey(family.id), id);
    setListId(id);
    setMessage(null);
    setError(null);
  };

  /** 選んだリストを読めず、端末にも無い：前のリストを出したままにしない */
  const notShown = (why: string) => {
    setServer(null);
    setError(why);
  };

  /** 読み直す。first なら、先に端末に持っている中身で描く */
  const load = useCallback(
    async (first = false) => {
      const g = gen.current;
      const read = ++reads.current;
      const readAt = getSyncState().sent;
      try {
        let id = listId;
        if (!id) {
          const lists = await api<ShoppingListSummary[]>("GET", `/families/${family.id}/shopping-lists`);
          if (lists.length === 0) {
            if (g === gen.current)
              setServer({ view: { list: { id: "", familyId: family.id, name: "" }, lists: [], sections: [], items: [], frequent: [] }, readAt });
            return;
          }
          id = lists[0]!.id;
          localStorage.setItem(listKey(family.id), id);
          setListId(id);
          return; // listId が変われば読み直す
        }
        if (first) {
          const cached = await cachedView(id);
          if (g !== gen.current) return;
          if (cached && cached.view.list.familyId === family.id) {
            setServer(cached);
            shown.current = id;
          }
        }
        const v = await api<ShoppingListView>("GET", `/shopping-lists/${id}`);
        // Family を切り替えたあとに前の Family のリストが残っていたら選び直す
        if (v.list.familyId !== family.id) throw new ApiError(404, "", "list_not_found");
        markOnline();
        if (getSyncState().ops.length > 0) void flushShopping();
        if (g !== gen.current || read < applied.current) return;
        applied.current = read;
        void saveView(v, readAt);
        setServer({ view: v, readAt });
        setError(null);
        if (!prefetched.current) {
          // ほかのお店のリストも端末に入れておく（売り場で電波が切れても開けるように）
          prefetched.current = true;
          void (async () => {
            for (const l of v.lists.filter((l) => l.id !== v.list.id)) {
              const at = getSyncState().sent;
              const other = await api<ShoppingListView>("GET", `/shopping-lists/${l.id}`).catch(() => null);
              if (other) await saveView(other, at);
            }
          })();
        }
      } catch (e) {
        if (g !== gen.current) return;
        if (e instanceof ApiError && e.code === "list_not_found") {
          localStorage.removeItem(listKey(family.id));
          setListId(null);
          return;
        }
        if (e instanceof ApiError && e.status === 401) {
          markAuthLost();
          if (shown.current !== listId) notShown("ログインが切れています。ログインし直してください");
          return;
        }
        if (!(e instanceof ApiError)) {
          // 電波が無い：端末に持っている中身のまま（無ければそう知らせる）
          markOffline();
          if (shown.current !== listId) notShown("電波がありません。このリストはまだこの端末に入っていません。つながる場所で一度開いてください");
          return;
        }
        setError(errorText(e));
      }
    },
    [family.id, listId],
  );

  useEffect(() => {
    void load(true);
    const tick = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  // 送る待ちを送り終えたら読み直す（ほかの人の変更と、送った結果を合わせる）
  const queued = sync.ops.length;
  useEffect(() => {
    if (sync.sent > 0 && queued === 0) void load();
  }, [sync.sent, queued, load]);

  /** 変更を端末に積む（画面にはすぐ出て、送れたら消える） */
  const change = (op: ShoppingOp) => {
    setError(null);
    return pushOp(op);
  };

  const addItem = (name: string, note: string, sectionId: string | null) => {
    const item: ShoppingItem = {
      id: newItemId(),
      listId: data!.list.id,
      name,
      note: note || null,
      sectionId,
      status: "open",
      addedByName: me.user.displayName,
      cartByName: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setMessage(null);
    return change({ kind: "add", listId: item.listId, item });
  };

  const toggle = (item: ShoppingItem) =>
    change({
      kind: "update",
      listId: item.listId,
      itemId: item.id,
      status: item.status === "open" ? "in_cart" : "open",
      by: me.user.displayName,
    });

  const setNote = (item: ShoppingItem, note: string) =>
    change({
      kind: "update",
      listId: item.listId,
      itemId: item.id,
      note: note.trim() || null,
      by: me.user.displayName,
    });

  const remove = (item: ShoppingItem) => change({ kind: "remove", listId: item.listId, itemId: item.id });

  const checkout = () => {
    const ids = data!.items.filter((i) => i.status === "in_cart").map((i) => i.id);
    setMessage(`${ids.length}点を買いました。また要るときは「よく買うもの」から入れられます。`);
    return change({
      kind: "checkout",
      listId: data!.list.id,
      itemIds: ids,
      at: new Date().toISOString(),
    });
  };

  if (!data)
    return (
      <main className="page">
        <h1>買い物</h1>
        <SyncBanner sync={sync} onRelogin={onAuthLost} />
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : (
          <p aria-busy="true">読み込んでいます…</p>
        )}
      </main>
    );

  const inCart = data.items.filter((i) => i.status === "in_cart");
  const hasList = data.lists.length > 0 && !!data.list.id;

  return (
    <main className="page shop">
      <h1 className="visually-hidden">買い物</h1>
      <SyncBanner sync={sync} onRelogin={onAuthLost} />
      <div className="shop-lists" role="tablist" aria-label="お店">
        {data.lists.map((l) => {
          const n = l.openCount + l.cartCount;
          return (
            <button key={l.id} role="tab" aria-selected={l.id === data.list.id} className="shop-lists__tab" onClick={() => choose(l.id)}>
              {l.name}
              {n > 0 && <span className="shop-lists__count">{n}</span>}
            </button>
          );
        })}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="notice notice--ok" role="status">
          {message}
        </p>
      )}

      {hasList ? (
        <>
          <AddForm key={data.list.id} view={data} onAdd={addItem} />
          <ItemSections view={data} onToggle={(i) => void toggle(i)} onNote={(i, n) => void setNote(i, n)} onRemove={(i) => void remove(i)} />
          <div className="shop-checkout">
            <button className="btn btn--primary btn--large" disabled={inCart.length === 0} onClick={() => void checkout()}>
              買い物を終える（{inCart.length}点）
            </button>
          </div>
        </>
      ) : (
        <p className="empty">リストがありません。下の「リストと売り場を編集」からお店のリストを作ってください。</p>
      )}

      <ShoppingEditor familyId={family.id} view={data} onChanged={load} onCreated={choose} />
    </main>
  );
}

/** 電波が無い・ログインが切れたときに、上に小さく出す。送れたら消える */
function SyncBanner({ sync, onRelogin }: { sync: SyncState; onRelogin: () => void }) {
  const n = sync.ops.length;
  const unsent = n > 0 ? `（未送信 ${n} 件）` : "";
  return (
    <>
      {sync.authLost ? (
        <div className="sync-banner sync-banner--auth" role="alert">
          <p>ログインが切れています。ログインし直すと送ります{`${unsent}。`}この端末のデータは消えません。</p>
          <button className="btn btn--small" onClick={onRelogin}>
            ログインし直す
          </button>
        </div>
      ) : sync.offline ? (
        <div className="sync-banner" role="status">
          <p>電波がありません。この端末に保存して、つながったら送ります{unsent}</p>
        </div>
      ) : null}
      {sync.dropped && (
        <div className="sync-banner sync-banner--dropped" role="alert">
          <p>送れなかった変更を取り消しました：{sync.dropped}</p>
          <button className="btn btn--small" onClick={clearDropped}>
            閉じる
          </button>
        </div>
      )}
    </>
  );
}

/** 品物を足す欄と「よく買うもの」のチップ。名前を打つと候補を絞り、前に買ったときの売り場を選んでおく */
function AddForm({ view, onAdd }: { view: ShoppingListView; onAdd: (name: string, note: string, sectionId: string | null) => Promise<void> }) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [section, setSection] = useState(NONE);
  const [sectionTouched, setSectionTouched] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const q = name.trim();
  const remembered = (n: string) => view.frequent.find((f) => f.name === n);
  const chips = q ? view.frequent.filter((f) => f.name.includes(q)).slice(0, CHIPS_MAX) : view.frequent.slice(0, CHIPS_MAX);
  const validSection = (id: string | null) => (id && view.sections.some((s) => s.id === id) ? id : null);

  const reset = () => {
    setName("");
    setNote("");
    setSection(NONE);
    setSectionTouched(false);
  };

  const pick = (f: FrequentItem) => {
    void onAdd(f.name, note.trim(), validSection(f.sectionId));
    reset();
  };

  return (
    <div className="shop-add">
      <form
        className="shop-add__form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!q) return;
          void onAdd(q, note.trim(), section === NONE ? null : section);
          reset();
          nameRef.current?.focus();
        }}
      >
        <label className="field shop-add__name">
          <span>品物を足す</span>
          <input
            ref={nameRef}
            value={name}
            maxLength={40}
            placeholder="例：牛乳"
            autoComplete="off"
            enterKeyHint="done"
            onChange={(e) => {
              setName(e.target.value);
              // 前に買ったことのある名前なら、そのときの売り場を選んでおく（自分で選んだあとは変えない）
              if (!sectionTouched) setSection(validSection(remembered(e.target.value.trim())?.sectionId ?? null) ?? NONE);
            }}
          />
        </label>
        <label className="field shop-add__note">
          <span>数量・メモ</span>
          <input value={note} maxLength={40} placeholder="例：2パック" autoComplete="off" onChange={(e) => setNote(e.target.value)} />
        </label>
        <label className="field shop-add__section">
          <span>売り場</span>
          <select
            aria-label="売り場"
            value={section}
            onChange={(e) => {
              setSection(e.target.value);
              setSectionTouched(true);
            }}
          >
            <option value={NONE}>売り場なし</option>
            {view.sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn--primary shop-add__submit" type="submit" disabled={!q}>
          足す
        </button>
      </form>
      {chips.length > 0 && (
        <div className="shop-frequent" role="group" aria-label="よく買うもの">
          <p className="shop-frequent__title">{q ? "前に買ったもの" : "よく買うもの"}</p>
          <ul className="shop-frequent__chips">
            {chips.map((f) => (
              <li key={f.name}>
                <button type="button" className="chip" onClick={() => pick(f)}>
                  <span aria-hidden="true" className="chip__plus">
                    ＋
                  </span>
                  {f.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** 売り場ごとの見出しで品物を並べる。カゴに入れたものはその売り場の下に薄く */
function ItemSections({
  view,
  onToggle,
  onNote,
  onRemove,
}: {
  view: ShoppingListView;
  onToggle: (i: ShoppingItem) => void;
  onNote: (i: ShoppingItem, note: string) => void;
  onRemove: (i: ShoppingItem) => void;
}) {
  const [editing, setEditing] = useState<{ id: string; note: string } | null>(null);
  if (view.items.length === 0) return <p className="shop-empty">このリストは空です。上の欄か「よく買うもの」から足してください。</p>;
  const groups = [...view.sections.map((s) => ({ key: s.id, name: s.name })), { key: NONE, name: "売り場なし" }]
    .map((g) => {
      const items = view.items.filter((i) => (i.sectionId && view.sections.some((s) => s.id === i.sectionId) ? i.sectionId : NONE) === g.key);
      return { ...g, items: [...items.filter((i) => i.status === "open"), ...items.filter((i) => i.status === "in_cart")] };
    })
    .filter((g) => g.items.length > 0);

  return (
    <div className="memo">
      {groups.map((g) => (
        <section key={g.key} className="memo__section" aria-labelledby={`sec-${g.key}`}>
          <h2 id={`sec-${g.key}`} className="memo__heading">
            {g.name}
          </h2>
          <ul className="memo__items">
            {g.items.map((i) => (
              <li key={i.id} className={`memo__item${i.status === "in_cart" ? " is-in-cart" : ""}`}>
                {editing?.id === i.id ? (
                  <form
                    className="memo__edit-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (editing.note.trim() !== (i.note ?? "")) onNote(i, editing.note);
                      setEditing(null);
                    }}
                  >
                    <span className="memo__name">{i.name}</span>
                    <input
                      autoFocus
                      value={editing.note}
                      maxLength={40}
                      placeholder="例：2パック"
                      aria-label={`「${i.name}」の数量やメモ`}
                      onChange={(e) => setEditing({ id: i.id, note: e.target.value })}
                    />
                    <button className="btn btn--small" type="submit">
                      決める
                    </button>
                    <button className="btn btn--small" type="button" onClick={() => setEditing(null)}>
                      やめる
                    </button>
                  </form>
                ) : (
                  <>
                    <button className="memo__toggle" aria-pressed={i.status === "in_cart"} onClick={() => onToggle(i)}>
                      <span className="memo__check" aria-hidden="true" />
                      <span className="memo__text">
                        <span className="memo__name">{i.name}</span>
                        {i.note && <span className="memo__note">{i.note}</span>}
                      </span>
                      <span className="memo__who">{i.status === "in_cart" ? `カゴ ${i.cartByName ?? ""}` : (i.addedByName ?? "")}</span>
                    </button>
                    <button className="memo__edit" aria-label={`「${i.name}」の数量やメモを直す`} onClick={() => setEditing({ id: i.id, note: i.note ?? "" })}>
                      ✎
                    </button>
                    <button className="memo__remove" aria-label={`「${i.name}」を消す`} onClick={() => onRemove(i)}>
                      ×
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

type Named = { id: string; name: string };

/** リストと売り場の名前を変える・足す・消す・並べ替える */
function ShoppingEditor({
  familyId,
  view,
  onChanged,
  onCreated,
}: {
  familyId: string;
  view: ShoppingListView;
  onChanged: () => Promise<void>;
  onCreated: (listId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);

  /** うまくいけば true */
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      await onChanged();
      setMessage({ kind: "ok", text: done });
      return true;
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="section groups-editor shop-editor">
      <summary>リストと売り場を編集</summary>
      {message && (
        <p className={message.kind === "ok" ? "notice notice--ok" : "error"} role={message.kind === "ok" ? "status" : "alert"}>
          {message.text}
        </p>
      )}
      <h2 className="shop-editor__title">お店のリスト</h2>
      <NamesEditor
        kind="リスト"
        items={view.lists}
        busy={busy}
        placeholder="例：ドラッグストア"
        onRename={(id, name) => run(() => api("PATCH", `/shopping-lists/${id}`, { name }), "名前を変えました")}
        onReorder={(ids) => run(() => Promise.all(ids.map((id, k) => api("PATCH", `/shopping-lists/${id}`, { sortOrder: k }))), "並べ替えました")}
        onDelete={(l) =>
          confirm(`リスト「${l.name}」を消しますか？ 入っている品物と、買った記録も消えます。`) &&
          run(() => api("DELETE", `/shopping-lists/${l.id}`), `「${l.name}」を消しました`)
        }
        onAdd={(name) =>
          run(async () => {
            const r = await api<{ id: string }>("POST", `/families/${familyId}/shopping-lists`, { name });
            onCreated(r.id);
          }, "リストを足しました")
        }
      />
      {view.list.id && (
        <>
          <h2 className="shop-editor__title">「{view.list.name}」の売り場</h2>
          <NamesEditor
            kind="売り場"
            items={view.sections}
            busy={busy}
            placeholder="例：お惣菜"
            onRename={(id, name) => run(() => api("PATCH", `/shopping-sections/${id}`, { name }), "名前を変えました")}
            onReorder={(ids) =>
              run(
                () =>
                  Promise.all(
                    ids.map((id, k) =>
                      api("PATCH", `/shopping-sections/${id}`, {
                        sortOrder: k,
                      }),
                    ),
                  ),
                "並べ替えました",
              )
            }
            onDelete={(s) =>
              confirm(`売り場「${s.name}」を消しますか？ 入っている品物は消えず、売り場なしになります。`) &&
              run(() => api("DELETE", `/shopping-sections/${s.id}`), `「${s.name}」を消しました`)
            }
            onAdd={(name) =>
              run(
                () =>
                  api("POST", `/shopping-lists/${view.list.id}/sections`, {
                    name,
                  }),
                "売り場を足しました",
              )
            }
          />
        </>
      )}
    </details>
  );
}

function NamesEditor({
  kind,
  items,
  busy,
  placeholder,
  onRename,
  onReorder,
  onDelete,
  onAdd,
}: {
  kind: string;
  items: Named[];
  busy: boolean;
  placeholder: string;
  onRename: (id: string, name: string) => unknown;
  onReorder: (ids: string[]) => unknown;
  onDelete: (item: Named) => unknown;
  onAdd: (name: string) => Promise<boolean>;
}) {
  const [names, setNames] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");

  /** 隣と入れ替える（並び順をつけ直す） */
  const move = (i: number, dir: -1 | 1) => {
    const order = items.map((x) => x.id);
    const j = i + dir;
    [order[i], order[j]] = [order[j]!, order[i]!];
    onReorder(order);
  };

  return (
    <>
      <ul className="list">
        {items.map((x, i) => {
          const value = names[x.id] ?? x.name;
          return (
            <li key={x.id} className="list__item">
              <form
                className="row-form group-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  onRename(x.id, value);
                }}
              >
                <input value={value} onChange={(e) => setNames({ ...names, [x.id]: e.target.value })} maxLength={20} aria-label={`${kind}「${x.name}」の名前`} />
                <button className="btn btn--small" type="submit" disabled={busy || value.trim() === x.name || !value.trim()}>
                  保存
                </button>
              </form>
              <div className="actions">
                <button className="btn btn--small" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={`${x.name}を上へ`}>
                  上へ
                </button>
                <button className="btn btn--small" disabled={busy || i === items.length - 1} onClick={() => move(i, 1)} aria-label={`${x.name}を下へ`}>
                  下へ
                </button>
                <button className="btn btn--danger-quiet" disabled={busy} onClick={() => onDelete(x)} aria-label={`${kind}「${x.name}」を消す`}>
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
          void onAdd(newName).then((ok) => ok && setNewName(""));
        }}
      >
        <label className="field field--short">
          <span>新しい{kind}</span>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={20} placeholder={placeholder} />
        </label>
        <button className="btn" type="submit" disabled={busy || !newName.trim()}>
          足す
        </button>
      </form>
    </>
  );
}
