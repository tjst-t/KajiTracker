// 買い物の API の形（src/worker/shopping/routes.ts）
export type ShoppingStatus = "open" | "in_cart";

export type ShoppingListSummary = { id: string; name: string; sortOrder: number; openCount: number; cartCount: number };
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
export type FrequentItem = { name: string; count: number; lastBoughtAt: string; sectionId: string | null };

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
