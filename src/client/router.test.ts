import { describe, expect, it } from "vitest";
import { type Route, pathOf, routeOf, tabOf } from "./router";

describe("router", () => {
  it("TODO・買い物・その他の URL", () => {
    for (const r of [{ name: "todos" }, { name: "shopping" }, { name: "more" }] as Route[]) expect(routeOf(pathOf(r))).toEqual(r);
    expect(pathOf({ name: "more" })).toBe("/more");
    expect(routeOf("/todos/abc")).toEqual({ name: "todo", id: "abc" });
    expect(pathOf({ name: "todo", id: "abc" })).toBe("/todos/abc");
  });

  it("統計・家族・設定は今までの URL のまま", () => {
    expect(routeOf("/stats")).toEqual({ name: "stats" });
    expect(routeOf("/family")).toEqual({ name: "family" });
    expect(routeOf("/settings")).toEqual({ name: "settings" });
  });

  it("統計・家族・設定を開いているときのタブは「その他」", () => {
    expect(["/stats", "/family", "/settings", "/more"].map((p) => tabOf(routeOf(p)))).toEqual(["more", "more", "more", "more"]);
    expect(["/", "/todos", "/todos/x", "/shopping", "/chores", "/chores/table", "/chores/x/edit"].map((p) => tabOf(routeOf(p)))).toEqual([
      "today",
      "todos",
      "todos",
      "shopping",
      "chores",
      "chores",
      "chores",
    ]);
  });
});
