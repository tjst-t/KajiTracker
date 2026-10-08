// 画面の行き先と URL。ライブラリは使わず history API だけで持つ
export type Route =
  | { name: "today" }
  | { name: "chores" }
  | { name: "chore-new" }
  | { name: "chore-bulk" }
  | { name: "chore-table" }
  | { name: "chore"; id: string }
  | { name: "chore-edit"; id: string }
  | { name: "stats" }
  | { name: "family" }
  | { name: "settings" };

export type Nav = { route: Route; go: (r: Route) => void; back: (fallback: Route) => void };

export function pathOf(r: Route): string {
  switch (r.name) {
    case "today":
      return "/";
    case "chores":
      return "/chores";
    case "chore-new":
      return "/chores/new";
    case "chore-bulk":
      return "/chores/bulk";
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
  }
}

export function routeOf(path: string): Route {
  let m: RegExpExecArray | null;
  if (path === "/chores/new") return { name: "chore-new" };
  if (path === "/chores/bulk") return { name: "chore-bulk" };
  if (path === "/chores/table") return { name: "chore-table" };
  if ((m = /^\/chores\/([^/]+)\/edit$/.exec(path))) return { name: "chore-edit", id: m[1]! };
  if ((m = /^\/chores\/([^/]+)$/.exec(path))) return { name: "chore", id: m[1]! };
  if (path.startsWith("/chores")) return { name: "chores" };
  if (path.startsWith("/stats")) return { name: "stats" };
  if (path.startsWith("/family")) return { name: "family" };
  if (path.startsWith("/settings")) return { name: "settings" };
  return { name: "today" };
}

/** タブ（今日・家事・統計・家族・設定）のどれに当たるか */
export function tabOf(r: Route): "today" | "chores" | "stats" | "family" | "settings" {
  if (r.name === "today") return "today";
  if (r.name === "stats") return "stats";
  if (r.name === "family") return "family";
  if (r.name === "settings") return "settings";
  return "chores";
}

/** 保存していない変更があるときに出す確かめ（表で直す）。null なら確かめない */
let leaveMessage: string | null = null;
export function setLeaveGuard(message: string | null) {
  leaveMessage = message;
}
/** この画面から離れてよいか。変更が残っていれば聞く */
export function confirmLeave(): boolean {
  return !leaveMessage || confirm(leaveMessage);
}
