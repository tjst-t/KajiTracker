// 買い物のデータを端末（IndexedDB）に持ち、変更を送る待ち（キュー）に積んで順に送る。
// 電波の弱い店でも、リストを見て・足して・カゴに入れられるように。決まりは docs/design.md「買い物を電波の弱い店で使う」。
// /api は Service Worker でキャッシュしない（public/sw.js）。データを持つのはこの画面側だけ。
import { ApiError, api } from "./api";
import { errorText } from "./format";
import { type ShoppingListView, type ShoppingOp, sendFailure } from "./shopping";

const DB_NAME = "kajitracker-shopping";
/** リストごとに、最後にサーバから読んだ中身。キーは `${userId}:${listId}` */
const VIEWS = "views";
/** 送る待ちの変更。キーの小さい順に送る */
const QUEUE = "queue";
/** 送れなかったときに送り直す間隔 */
const RETRY_MS = 20_000;

type Queued = { key: number; userId: string; op: ShoppingOp };

export type SyncState = {
  /** 端末の送る待ちを読み終えた */
  ready: boolean;
  /** まだ送っていない変更（古い順） */
  ops: readonly ShoppingOp[];
  /** 電波がない（送れなかった・読めなかった） */
  offline: boolean;
  /** ログインが切れていて送れない */
  authLost: boolean;
  /** 送ったが受け付けられず、捨てた変更のわけ */
  dropped: string | null;
  /** 送れた変更の数（増えたら画面が読み直す） */
  sent: number;
  /** 送れた変更（新しいほう 100 件）。seq は送れた順の番号（sent と同じ数え方） */
  done: readonly { seq: number; op: ShoppingOp }[];
};

/**
 * 画面に重ねる変更：サーバから読み始めたとき（readAt ＝ そのときの sent）よりあとに送れたものと、まだ送っていないもの。
 * 送れてから読み直すまでの間に、画面が前の状態に戻らないように
 */
export const opsToApply = (s: SyncState, readAt: number): ShoppingOp[] => [...s.done.filter((d) => d.seq > readAt).map((d) => d.op), ...s.ops];

// ---- IndexedDB の小さなラッパー（使えない端末では、開いている間だけメモリに持つ） ----

let dbp: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbp ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(VIEWS);
        req.result.createObjectStore(QUEUE, { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

async function idb<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  const d = await openDb();
  if (!d) return undefined;
  return new Promise<T>((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const memViews = new Map<string, SavedView>();

// ---- 状態 ----

let userId: string | null = null;
let queue: Queued[] = [];
let lastKey = 0;
/** IndexedDB にまだ入っていない（入れられなかった）送る待ちのキー */
const unsaved = new Set<number>();
let state: SyncState = {
  ready: false,
  ops: [],
  offline: false,
  authLost: false,
  dropped: null,
  sent: 0,
  done: [],
};
const listeners = new Set<() => void>();

function set(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

function setQueue(q: Queued[], patch: Partial<SyncState> = {}) {
  queue = q;
  set({ ...patch, ops: q.map((x) => x.op) });
}

export const getSyncState = () => state;
export function subscribeSync(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export const markOffline = () => state.offline || set({ offline: true });
export const markOnline = () => state.offline && set({ offline: false });
export const markAuthLost = () => state.authLost || set({ authLost: true });
export const clearDropped = () => state.dropped && set({ dropped: null });

let started = false;

/**
 * ログインしている人（わからなければ前にログインしていた人）の送る待ちを読み、送り始める。
 * ログインし直したときにも呼ぶ（ログインが切れた印を消して送り直す）
 */
export async function startShoppingSync(uid: string) {
  if (!started) {
    started = true;
    addEventListener("online", () => void flushShopping());
    addEventListener("offline", markOffline);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && queue.length > 0) void flushShopping();
    });
    setInterval(() => {
      if (queue.length > 0 && !state.authLost) void flushShopping();
    }, RETRY_MS);
  }
  if (uid !== userId) {
    userId = uid;
    const all = (await idb<Queued[]>(QUEUE, "readonly", (s) => s.getAll()).catch(() => undefined)) ?? [];
    if (userId !== uid) return;
    lastKey = Math.max(lastKey, ...all.map((x) => x.key));
    // メモリにだけある（IndexedDB が使えない端末で積んだ）分も残す
    const mem = queue.filter((x) => x.userId === uid && !all.some((y) => y.key === x.key));
    setQueue(
      [...all.filter((x) => x.userId === uid), ...mem].sort((a, b) => a.key - b.key),
      { ready: true, authLost: false },
    );
  } else set({ ready: true, authLost: false });
  if (navigator.onLine === false) markOffline();
  void flushShopping();
}

/** この画面を開いてからの印。sent の数え方は開くたびに 0 から */
const SESSION = Math.random().toString(36).slice(2);
type SavedView = { view: ShoppingListView; readAt: number; session: string };

/** 最後にサーバから読んだ中身と、読み始めたときの sent（端末に無ければ null） */
export async function cachedView(listId: string): Promise<{ view: ShoppingListView; readAt: number } | null> {
  const key = `${userId}:${listId}`;
  const v = memViews.get(key) ?? (await idb<SavedView>(VIEWS, "readonly", (s) => s.get(key)).catch(() => undefined));
  if (!v?.view) return null;
  // 前に開いたときに入れたもの：そのとき送れた変更はもう中身に入っている。今回送れたものはみな重ねる
  return { view: v.view, readAt: v.session === SESSION ? v.readAt : 0 };
}

export async function saveView(view: ShoppingListView, readAt: number) {
  const key = `${userId}:${view.list.id}`;
  const v: SavedView = { view, readAt, session: SESSION };
  memViews.set(key, v);
  await idb(VIEWS, "readwrite", (s) => s.put(v, key)).catch(() => {});
}

/** 変更を送る待ちに積み（画面にはすぐ出る）、送る */
export async function pushOp(op: ShoppingOp) {
  if (!userId) return;
  const q: Queued = {
    key: (lastKey = Math.max(lastKey + 1, Date.now() * 1000)),
    userId,
    op,
  };
  unsaved.add(q.key);
  setQueue([...queue, q], { dropped: null });
  const saved = await idb(QUEUE, "readwrite", (s) => s.put(q)).then(
    () => true,
    () => false,
  );
  if (saved && (await openDb())) unsaved.delete(q.key);
  void flushShopping();
}

// ---- 送る ----

let flushing: Promise<void> | null = null;
let again = false;

/** 送る待ちを古い順に送る。同時には1本だけ（ほかのタブとも locks で順番に） */
export function flushShopping(): Promise<void> {
  if (flushing) {
    again = true;
    return flushing;
  }
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  const run = async () => {
    do {
      again = false;
      await sendAll();
    } while (again);
  };
  flushing = (locks ? locks.request("kajitracker-shopping-send", run) : run()).finally(() => {
    flushing = null;
  });
  return flushing;
}

async function sendAll() {
  const uid = userId;
  while (queue.length > 0 && userId === uid) {
    const q = queue[0]!;
    // ほかのタブがもう送って消したもの（古い変更で上書きしないよう、送らずに外す）
    const gone = !unsaved.has(q.key) && (await idb<Queued>(QUEUE, "readonly", (s) => s.get(q.key)).catch(() => q)) === undefined;
    let dropped: string | null = null;
    if (!gone) {
      try {
        await send(q.op);
      } catch (e) {
        const how = sendFailure(e);
        if (how === "retry") return markOffline();
        if (how === "auth") return markAuthLost();
        // 相手が消した・買い物を終えた品物への変更は、黙って捨てる（読み直した中身に合わせる）
        if (!(e instanceof ApiError && e.code === "item_not_found")) dropped = errorText(e);
      }
    }
    await idb(QUEUE, "readwrite", (s) => s.delete(q.key)).catch(() => {});
    unsaved.delete(q.key);
    const seq = state.sent + 1;
    setQueue(
      queue.filter((x) => x.key !== q.key),
      { offline: false, authLost: false, sent: seq, done: [...state.done.slice(-99), { seq, op: q.op }], ...(dropped ? { dropped } : {}) },
    );
  }
}

/** 1つの変更を送る。どの API も同じものを2回送っても結果が同じ（送り直してよい） */
async function send(op: ShoppingOp): Promise<void> {
  let r: unknown;
  if (op.kind === "add") {
    const { id, name, note, sectionId } = op.item;
    const post = (sid: string | null) =>
      api("POST", `/shopping-lists/${op.listId}/items`, {
        id,
        name,
        note: note ?? "",
        sectionId: sid,
      });
    try {
      r = await post(sectionId);
    } catch (e) {
      // 送れない間に売り場が消された：売り場なしで入れる
      if (!(e instanceof ApiError && e.status === 400 && sectionId)) throw e;
      r = await post(null);
    }
  } else if (op.kind === "update") {
    r = await api("PATCH", `/shopping-items/${op.itemId}`, {
      status: op.status,
      note: op.note,
    });
  } else if (op.kind === "remove") {
    r = await api("DELETE", `/shopping-items/${op.itemId}`);
  } else {
    r = await api("POST", `/shopping-lists/${op.listId}/checkout`, {
      itemIds: op.itemIds,
    });
  }
  // お店の Wi-Fi のログイン画面などが 200 で HTML を返したときは、届いていない
  if (!r || typeof r !== "object") throw new Error("サーバに届きませんでした");
}
