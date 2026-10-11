import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type Family, type Me, api } from "../api";
import { errorText } from "../format";
import { type FrequentItem, type ShoppingItem, type ShoppingListSummary, type ShoppingListView, newItemId } from "../shopping";

/** 画面を開いている間、読み直す間隔（画面が見えているときだけ） */
const POLL_MS = 5000;
/** 入力が空のときに出す「よく買うもの」の数 */
const CHIPS_MAX = 12;
const NONE = "__none__";

const listKey = (familyId: string) => `kaji.shoppingList.${familyId}`;

/** 買い物メモ。お店ごとのリストを切り替え、売り場ごとに品物を並べる。タップでカゴに入れ、「買い物を終える」で履歴へ */
export function Shopping({ me, family }: { me: Me; family: Family }) {
  const [listId, setListId] = useState<string | null>(() => localStorage.getItem(listKey(family.id)));
  const [data, setData] = useState<ShoppingListView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // 書き込みの途中・直後に、古い読み直しの結果で画面を戻さないように
  const pending = useRef(0);
  const gen = useRef(0);

  const choose = (id: string) => {
    gen.current++; // 前のリストの読み直しの結果を捨てる
    localStorage.setItem(listKey(family.id), id);
    setListId(id);
    setMessage(null);
  };

  const load = useCallback(async () => {
    const g = gen.current;
    try {
      let id = listId;
      if (!id) {
        const lists = await api<ShoppingListSummary[]>("GET", `/families/${family.id}/shopping-lists`);
        if (lists.length === 0) {
          if (g === gen.current) setData({ list: { id: "", familyId: family.id, name: "" }, lists: [], sections: [], items: [], frequent: [] });
          return;
        }
        id = lists[0]!.id;
        localStorage.setItem(listKey(family.id), id);
        setListId(id);
        return; // listId が変われば読み直す
      }
      const v = await api<ShoppingListView>("GET", `/shopping-lists/${id}`);
      if (g !== gen.current || pending.current > 0) return;
      // Family を切り替えたあとに前の Family のリストが残っていたら選び直す
      if (v.list.familyId !== family.id) throw new ApiError(404, "", "list_not_found");
      setData(v);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === "list_not_found") {
        localStorage.removeItem(listKey(family.id));
        setListId(null);
        return;
      }
      if (g === gen.current) setError(errorText(e));
    }
  }, [family.id, listId]);

  useEffect(() => {
    void load();
    const tick = () => {
      if (document.visibilityState === "visible" && pending.current === 0) void load();
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  /** 画面を先に変えてから送る。終わったら読み直す（失敗したら知らせて読み直す） */
  const mutate = async (local: (d: ShoppingListView) => ShoppingListView, send: () => Promise<unknown>) => {
    gen.current++;
    pending.current++;
    setData((d) => (d ? local(d) : d));
    setError(null);
    try {
      await send();
    } catch (e) {
      setError(errorText(e));
    } finally {
      pending.current--;
      gen.current++;
      if (pending.current === 0) void load();
    }
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
    return mutate(
      (d) => ({ ...d, items: [...d.items, item], frequent: d.frequent.filter((f) => f.name !== name) }),
      () => api("POST", `/shopping-lists/${item.listId}/items`, { id: item.id, name, note, sectionId }),
    );
  };

  const toggle = (item: ShoppingItem) => {
    const status = item.status === "open" ? "in_cart" : "open";
    const cartByName = status === "in_cart" ? me.user.displayName : null;
    return mutate(
      (d) => ({ ...d, items: d.items.map((i) => (i.id === item.id ? { ...i, status, cartByName } : i)) }),
      () => api("PATCH", `/shopping-items/${item.id}`, { status }),
    );
  };

  const remove = (item: ShoppingItem) =>
    mutate(
      (d) => ({ ...d, items: d.items.filter((i) => i.id !== item.id) }),
      () => api("DELETE", `/shopping-items/${item.id}`),
    );

  const checkout = () => {
    const ids = data!.items.filter((i) => i.status === "in_cart").map((i) => i.id);
    const listId = data!.list.id;
    return mutate(
      (d) => ({ ...d, items: d.items.filter((i) => !ids.includes(i.id)) }),
      async () => {
        const r = await api<{ purchased: number }>("POST", `/shopping-lists/${listId}/checkout`, { itemIds: ids });
        setMessage(`${r.purchased}点を買いました。また要るときは「よく買うもの」から入れられます。`);
      },
    );
  };

  if (!data)
    return (
      <main className="page">
        <h1>買い物</h1>
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
          <ItemSections view={data} onToggle={(i) => void toggle(i)} onRemove={(i) => void remove(i)} />
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
function ItemSections({ view, onToggle, onRemove }: { view: ShoppingListView; onToggle: (i: ShoppingItem) => void; onRemove: (i: ShoppingItem) => void }) {
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
                <button className="memo__toggle" aria-pressed={i.status === "in_cart"} onClick={() => onToggle(i)}>
                  <span className="memo__check" aria-hidden="true" />
                  <span className="memo__text">
                    <span className="memo__name">{i.name}</span>
                    {i.note && <span className="memo__note">{i.note}</span>}
                  </span>
                  <span className="memo__who">{i.status === "in_cart" ? `カゴ ${i.cartByName ?? ""}` : (i.addedByName ?? "")}</span>
                </button>
                <button className="memo__remove" aria-label={`「${i.name}」を消す`} onClick={() => onRemove(i)}>
                  ×
                </button>
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
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

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
            onReorder={(ids) => run(() => Promise.all(ids.map((id, k) => api("PATCH", `/shopping-sections/${id}`, { sortOrder: k }))), "並べ替えました")}
            onDelete={(s) =>
              confirm(`売り場「${s.name}」を消しますか？ 入っている品物は消えず、売り場なしになります。`) &&
              run(() => api("DELETE", `/shopping-sections/${s.id}`), `「${s.name}」を消しました`)
            }
            onAdd={(name) => run(() => api("POST", `/shopping-lists/${view.list.id}/sections`, { name }), "売り場を足しました")}
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
