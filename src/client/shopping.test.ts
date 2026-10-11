import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { type ShoppingItem, type ShoppingListView, applyOps, sendFailure } from "./shopping";

const item = (id: string, name: string, patch: Partial<ShoppingItem> = {}): ShoppingItem => ({
  id,
  listId: "L",
  name,
  note: null,
  sectionId: null,
  status: "open",
  addedByName: "たくみ",
  cartByName: null,
  createdAt: "2026-10-11T00:00:00.000Z",
  updatedAt: "2026-10-11T00:00:00.000Z",
  ...patch,
});

const view = (items: ShoppingItem[], frequent: ShoppingListView["frequent"] = []): ShoppingListView => ({
  list: { id: "L", familyId: "F", name: "スーパー" },
  lists: [
    { id: "L", name: "スーパー", sortOrder: 0, openCount: 0, cartCount: 0 },
    { id: "M", name: "コストコ", sortOrder: 1, openCount: 4, cartCount: 0 },
  ],
  sections: [],
  items,
  frequent,
});

describe("applyOps（端末に積んだ変更を重ねる）", () => {
  it("足す・カゴに入れる・数量メモ・消すを順に重ね、数を数え直す", () => {
    const v = applyOps(view([item("a", "牛乳"), item("b", "卵")], [{ name: "パン", count: 2, lastBoughtAt: "x", sectionId: null }]), [
      { kind: "add", listId: "L", item: item("c", "パン") },
      { kind: "update", listId: "L", itemId: "a", status: "in_cart", by: "はなこ" },
      { kind: "update", listId: "L", itemId: "c", note: "6枚切り", by: "はなこ" },
      { kind: "remove", listId: "L", itemId: "b" },
    ]);
    expect(v.items.map((i) => [i.name, i.status, i.note, i.cartByName])).toEqual([
      ["牛乳", "in_cart", null, "はなこ"],
      ["パン", "open", "6枚切り", null],
    ]);
    expect(v.frequent).toEqual([]);
    expect(v.lists[0]).toMatchObject({ openCount: 1, cartCount: 1 });
    expect(v.lists[1]).toMatchObject({ openCount: 4 });
  });

  it("無い品物への変更は捨てる（相手が消した品物にカゴの印を付けても壊れない）", () => {
    const base = view([item("a", "牛乳")]);
    const v = applyOps(base, [
      { kind: "update", listId: "L", itemId: "gone", status: "in_cart", by: "はなこ" },
      { kind: "remove", listId: "L", itemId: "gone2" },
    ]);
    expect(v.items).toEqual(base.items);
  });

  it("同じ品物を2回足しても1つ（送ったあとに読み直した中身にも重ねてよい）", () => {
    const v = applyOps(view([item("a", "牛乳")]), [{ kind: "add", listId: "L", item: item("a", "牛乳") }]);
    expect(v.items).toHaveLength(1);
  });

  it("買い物を終える：送った時点でカゴにあるものだけ外し、よく買うものに出す", () => {
    const v = applyOps(view([item("a", "牛乳", { status: "in_cart" }), item("b", "卵", { status: "in_cart" }), item("c", "パン")]), [
      { kind: "checkout", listId: "L", itemIds: ["a", "c"], at: "2026-10-11T01:00:00.000Z" },
    ]);
    expect(v.items.map((i) => i.name)).toEqual(["卵", "パン"]);
    expect(v.frequent.map((f) => f.name)).toEqual(["牛乳"]);
  });

  it("ほかのリストの変更は重ねない", () => {
    const base = view([item("a", "牛乳")]);
    expect(applyOps(base, [{ kind: "remove", listId: "M", itemId: "a" }])).toBe(base);
  });
});

describe("sendFailure（送れなかったとき）", () => {
  it("電波が無い・サーバの不調は送り直す、ログイン切れは待つ、受け付けられないものは捨てる", () => {
    expect(sendFailure(new TypeError("Failed to fetch"))).toBe("retry");
    expect(sendFailure(new ApiError(503, "x"))).toBe("retry");
    expect(sendFailure(new ApiError(429, "x"))).toBe("retry");
    expect(sendFailure(new ApiError(401, "x"))).toBe("auth");
    expect(sendFailure(new ApiError(404, "x", "item_not_found"))).toBe("drop");
    expect(sendFailure(new ApiError(400, "x"))).toBe("drop");
  });
});
