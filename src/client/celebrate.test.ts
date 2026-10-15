import { describe, expect, it } from "vitest";
import { breakdownText } from "./celebrate";

describe("皆済の内訳", () => {
  it("人ごとの件数を多い順に「・」でつなぐ", () => {
    expect(breakdownText(["はなこ", "たくみ", "たくみ", "はなこ", "たくみ"])).toBe("たくみ 3・はなこ 2");
  });
  it("同じ件数なら名前順、だれもいなければ空", () => {
    expect(breakdownText(["はなこ", "たくみ"])).toBe("たくみ 1・はなこ 1");
    expect(breakdownText([])).toBe("");
  });
});
