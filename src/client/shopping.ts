// 買い物の API の形（src/worker/shopping/routes.ts）
export type ShoppingStatus = "open" | "in_cart";

export type ShoppingListSummary = {
  id: string;
  name: string;
  sortOrder: number;
  openCount: number;
  cartCount: number;
};
export type ShoppingSection = { id: string; name: string; sortOrder: number };
export type ShoppingItem = {
  id: string;
  listId: string;
  name: string;
  note: string | null;
  sectionId: string | null;
  status: ShoppingStatus;
  addedByName: string | null;
  cartByName: string | null;
  createdAt: string;
  updatedAt: string;
};
/** よく買うもの：そのリストで前に買った名前（回数の多い順・新しい順）と、最後に買ったときの売り場 */
export type FrequentItem = {
  name: string;
  count: number;
  lastBoughtAt: string;
  sectionId: string | null;
};

export type ShoppingListView = {
  list: { id: string; familyId: string; name: string };
  lists: ShoppingListSummary[];
  sections: ShoppingSection[];
  items: ShoppingItem[];
  frequent: FrequentItem[];
};

/** 品物の id は画面で作る（送り直しても1件になるように） */
export function newItemId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---- 端末に積む変更（docs/design.md「買い物を電波の弱い店で使う」） ----

/** 送る待ちの変更。画面はサーバから読んだ中身にこれを順に重ねて描く */
export type ShoppingOp =
  | { kind: "add"; listId: string; item: ShoppingItem }
  /** なってほしい状態・数量メモ（切り替えではない）。by はカゴに入れた人として画面に出す名前 */
  | {
      kind: "update";
      listId: string;
      itemId: string;
      status?: ShoppingStatus;
      note?: string | null;
      by: string;
    }
  | { kind: "remove"; listId: string; itemId: string }
  | { kind: "checkout"; listId: string; itemIds: string[]; at: string };

/**
 * サーバから読んだ中身に、まだ送っていない変更を重ねる。
 * 無い品物への変更は捨てる（相手が消した・買い物を終えた品物にカゴの印を付けた、など）
 */
export function applyOps(view: ShoppingListView, ops: readonly ShoppingOp[]): ShoppingListView {
  const mine = ops.filter((o) => o.listId === view.list.id);
  if (mine.length === 0) return view;
  let items = view.items;
  let frequent = view.frequent;
  for (const op of mine) {
    if (op.kind === "add") {
      if (items.some((i) => i.id === op.item.id)) continue;
      items = [...items, op.item];
      frequent = frequent.filter((f) => f.name !== op.item.name);
    } else if (op.kind === "update") {
      items = items.map((i) => {
        if (i.id !== op.itemId) return i;
        const next = { ...i };
        if (op.status !== undefined && op.status !== i.status) {
          next.status = op.status;
          next.cartByName = op.status === "in_cart" ? op.by : null;
        }
        if (op.note !== undefined) next.note = op.note;
        return next;
      });
    } else if (op.kind === "remove") {
      items = items.filter((i) => i.id !== op.itemId);
    } else {
      const bought = items.filter((i) => i.status === "in_cart" && op.itemIds.includes(i.id));
      items = items.filter((i) => !bought.includes(i));
      const names = new Set(items.map((i) => i.name));
      const back = bought
        .filter((i, k) => !names.has(i.name) && bought.findIndex((b) => b.name === i.name) === k && !frequent.some((f) => f.name === i.name))
        .map((i) => ({
          name: i.name,
          count: 1,
          lastBoughtAt: op.at,
          sectionId: i.sectionId,
        }));
      frequent = [...back, ...frequent];
    }
  }
  const openCount = items.filter((i) => i.status === "open").length;
  const cartCount = items.length - openCount;
  const lists = view.lists.map((l) => (l.id === view.list.id ? { ...l, openCount, cartCount } : l));
  return { ...view, lists, items, frequent };
}

/** 送れなかったときにどうするか：retry（つながったら送り直す）・auth（ログインし直すまで待つ）・drop（捨てる） */
export function sendFailure(e: unknown): "retry" | "auth" | "drop" {
  const status = (e as { status?: unknown })?.status;
  if (typeof status !== "number" || status === 0) return "retry"; // fetch そのものが落ちた（電波がない）
  if (status === 401) return "auth";
  if (status === 408 || status === 429 || status >= 500) return "retry";
  return "drop";
}
