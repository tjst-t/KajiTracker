import { describe, expect, it } from "vitest";
import { breakdown } from "./celebrate";

describe("ぜんぶ完了の内訳", () => {
  it("人ごとの件数を多い順に", () => {
    expect(breakdown(["はなこ", "たくみ", "たくみ", "はなこ", "たくみ"])).toEqual([
      ["たくみ", 3],
      ["はなこ", 2],
    ]);
  });
  it("同じ件数なら名前順、だれもいなければ空", () => {
    expect(breakdown(["はなこ", "たくみ"])).toEqual([
      ["たくみ", 1],
      ["はなこ", 1],
    ]);
    expect(breakdown([])).toEqual([]);
  });
});
