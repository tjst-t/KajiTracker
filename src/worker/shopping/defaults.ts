// 最初から入れておく買い物のリストと売り場（Family を作ったとき・リストを足したとき）
import type { Db } from "../db";
import { shoppingLists, shoppingSections } from "../db/schema";
import { newId } from "../lib/crypto";

export const DEFAULT_SHOPPING_LISTS = ["スーパー", "コストコ", "IKEA"];
export const DEFAULT_SECTIONS = ["野菜・果物", "肉・魚", "乳製品・卵", "パン・主食", "調味料・乾物", "飲み物", "お菓子", "冷凍食品", "日用品", "その他"];

/** 新しいリストの売り場を入れる文（batch に混ぜる） */
export function insertDefaultSections(db: Db, listId: string) {
  return db.insert(shoppingSections).values(DEFAULT_SECTIONS.map((name, i) => ({ id: newId(), listId, name, sortOrder: i })));
}

/** Family を作ったときの、最初のリストと売り場を入れる文（batch に混ぜる） */
export function insertDefaultShopping(db: Db, familyId: string) {
  const lists = DEFAULT_SHOPPING_LISTS.map((name, i) => ({ id: newId(), familyId, name, sortOrder: i }));
  return [db.insert(shoppingLists).values(lists), ...lists.map((l) => insertDefaultSections(db, l.id))] as const;
}
