// 画面の行き先と URL。ライブラリは使わず history API だけで持つ
export type Route =
  | { name: "today" }
  | { name: "todos" }
  | { name: "shopping" }
  | { name: "chores" }
  | { name: "chore-new" }
  | { name: "chore-table" }
  | { name: "chore"; id: string }
  | { name: "chore-edit"; id: string }
  | { name: "stats" }
  | { name: "family" }
  | { name: "settings" }
  | { name: "more" };

export type Nav = { route: Route; go: (r: Route) => void; back: (fallback: Route) => void };

export function pathOf(r: Route): string {
  switch (r.name) {
    case "today":
      return "/";
    case "todos":
      return "/todos";
    case "shopping":
      return "/shopping";
    case "chores":
      return "/chores";
    case "chore-new":
      return "/chores/new";
    case "chore-table":
      return "/chores/table";
    case "chore":
      return `/chores/${r.id}`;
    case "chore-edit":
      return `/chores/${r.id}/edit`;
    case "stats":
      return "/stats";
    case "family":
      return "/family";
    case "settings":
      return "/settings";
    case "more":
      return "/more";
  }
}

export function routeOf(path: string): Route {
  let m: RegExpExecArray | null;
  if (path === "/chores/new") return { name: "chore-new" };
  // 前の「まとめて登録」の URL は表で編集へ（App が URL も書き換える）
  if (path === "/chores/table" || path === "/chores/bulk") return { name: "chore-table" };
  if ((m = /^\/chores\/([^/]+)\/edit$/.exec(path))) return { name: "chore-edit", id: m[1]! };
  if ((m = /^\/chores\/([^/]+)$/.exec(path))) return { name: "chore", id: m[1]! };
  if (path.startsWith("/chores")) return { name: "chores" };
  if (path.startsWith("/todos")) return { name: "todos" };
  if (path.startsWith("/shopping")) return { name: "shopping" };
  if (path.startsWith("/more")) return { name: "more" };
  if (path.startsWith("/stats")) return { name: "stats" };
  if (path.startsWith("/family")) return { name: "family" };
  if (path.startsWith("/settings")) return { name: "settings" };
  return { name: "today" };
}

/** 前の URL（/chores/bulk など）で開いたら、URL をその画面のものに書き換える（履歴は増やさない） */
export function fixPath(r: Route): Route {
  const want = pathOf(r);
  if (r.name === "chore-table" && location.pathname !== want) history.replaceState(null, "", want + location.search);
  return r;
}

export type Tab = "today" | "todos" | "shopping" | "chores" | "more";

/** タブ（今日・TODO・買い物・家事・その他）のどれに当たるか。統計・家族・設定は「その他」の中 */
export function tabOf(r: Route): Tab {
  switch (r.name) {
    case "today":
    case "todos":
    case "shopping":
    case "more":
      return r.name;
    case "stats":
    case "family":
    case "settings":
      return "more";
    default:
      return "chores";
  }
}

/** 保存していない変更があるときに出す確かめ（表で編集）。null なら確かめない */
let leaveMessage: string | null = null;
export function setLeaveGuard(message: string | null) {
  leaveMessage = message;
}
/** この画面から離れてよいか。変更が残っていれば聞く */
export function confirmLeave(): boolean {
  return !leaveMessage || confirm(leaveMessage);
}
