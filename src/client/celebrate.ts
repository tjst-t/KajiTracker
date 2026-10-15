// 完了の演出の決まり：端末ごとのオン・オフ、動きを減らす設定、振動、花丸を出したかどうか（Family ごとに1日1回）
import { useSyncExternalStore } from "react";

const SETTING_KEY = "kaji.celebrate";
const ALL_DONE_KEY = "kaji.allDone";
const listeners = new Set<() => void>();

/** 設定の「完了の演出」（端末ごと、初期はオン） */
export function celebrationOn(): boolean {
  try {
    return localStorage.getItem(SETTING_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setCelebration(on: boolean) {
  try {
    if (on) localStorage.removeItem(SETTING_KEY);
    else localStorage.setItem(SETTING_KEY, "off");
  } catch {
    // 保存できない端末では、この画面のあいだだけ
  }
  listeners.forEach((l) => l());
}

const reduceQuery = () => (typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null);

/** 動かしてよいか（演出がオンで、動きを減らす設定でない） */
export function motionOk(): boolean {
  return celebrationOn() && !reduceQuery()?.matches;
}

function subscribe(l: () => void) {
  listeners.add(l);
  const q = reduceQuery();
  q?.addEventListener("change", l);
  return () => {
    listeners.delete(l);
    q?.removeEventListener("change", l);
  };
}

/** 動かしてよいか（設定や OS の設定が変われば描き直す） */
export function useMotion(): boolean {
  return useSyncExternalStore(subscribe, motionOk, () => false);
}

export function useCelebrationSetting(): [boolean, (on: boolean) => void] {
  return [useSyncExternalStore(subscribe, celebrationOn, () => true), setCelebration];
}

/** 短い振動（振動できる端末で、動かしてよいときだけ） */
export function buzz(pattern: number | number[]) {
  if (!motionOk() || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // 振動できなくても困らない
  }
}

/** チェックの丸に「✓」を押す動き。押した要素にクラスを付け、動き終わったら外す */
export function popCheck(el: HTMLElement) {
  if (!motionOk()) return;
  el.classList.remove("is-popping");
  void el.offsetWidth; // 続けて押したときも最初から動かす
  el.classList.add("is-popping");
  window.setTimeout(() => el.classList.remove("is-popping"), 400);
}

function allDoneRecord(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ALL_DONE_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/** その日、その Family で「ぜんぶ完了」の花丸をもう出したか */
export const allDoneShown = (familyId: string, today: string) => allDoneRecord()[familyId] === today;

export function markAllDone(familyId: string, today: string) {
  try {
    localStorage.setItem(ALL_DONE_KEY, JSON.stringify({ ...allDoneRecord(), [familyId]: today }));
  } catch {
    // 保存できなければ、次に全部済んだときにまた出る
  }
}

/** 人ごとの件数 [["たくみ", 3], ["はなこ", 2]]（多い順、同じなら名前順） */
export function breakdown(names: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"));
}
