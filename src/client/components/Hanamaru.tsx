// 今日の当番がぜんぶ済んだときの「花丸」：先生の赤ペンの花丸が筆の線で描かれ、描き終わりに朱の判子「よくできました」。
// 同時に画面が小さく揺れ、左右の下から紙吹雪。動きを減らすときは、描き終わった形と判子と文だけを静かに出す
import { useEffect, useId, useRef, useState } from "react";
import { buzz, motionOk } from "../celebrate";
import { Confetti } from "./Confetti";

/** 花丸を描きはじめるまで・描く長さ・判子が押される瞬間（ms）。CSS の時間と合わせる */
const DRAW_START = 150;
const DRAW_MS = 900;
const IMPACT_MS = DRAW_START + DRAW_MS;

type Stroke = { d: string; w: number; delay: number; dur: number };

/**
 * 花丸の線。真ん中を空けたうずまき（内から外へ 1 周半ほど）から、そのまま花びらの外周を 1 周。
 * 筆の強弱は、線を何本かに分けて太さを変えて出す（SVG の線は 1 本の中で太さを変えられない）
 */
const STROKES: Stroke[] = (() => {
  const C = 100;
  const pts = (from: number, to: number, r: (a: number) => number, step = 0.05) => {
    const out: [number, number][] = [];
    for (let a = from; ; a += step) {
      const t = Math.min(a, to);
      out.push([C + Math.cos(t) * r(t), C + Math.sin(t) * r(t)]);
      if (t === to) return out;
    }
  };
  const len = (p: [number, number][]) => p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p[i]![0], q[1] - p[i]![1]), 0);
  const d = (p: [number, number][]) => `M${p.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L")}`;

  // うずまき：半径 30 → 60、少しゆらす
  const a0 = -2.4;
  const turns = Math.PI * 2 * 1.6;
  const spiral = (a: number) => 30 + (30 * (a - a0)) / turns + Math.sin(a * 3) * 1.2;
  const sWidths = [4, 5.5, 7, 8, 8.5, 7];
  const parts: { p: [number, number][]; w: number }[] = sWidths.map((w, i) => ({
    p: pts(a0 + (turns * i) / sWidths.length, a0 + (turns * (i + 1)) / sWidths.length, spiral),
    w,
  }));
  // 花びら：うずまきの終わりから、8 枚の花びらで 1 周（少し重ねて閉じる）
  const a1 = a0 + turns;
  const N = 8;
  const petal = (a: number) => 64 + 22 * Math.abs(Math.sin((N * (a - a1)) / 2)) ** 0.8;
  const pWidths = [8.5, 7, 8, 6.5, 7.5, 7, 8, 5.5];
  pWidths.forEach((w, i) => {
    const span = (Math.PI * 2 + 0.25) / N;
    parts.push({ p: pts(a1 + span * i, a1 + span * (i + 1), petal, 0.03), w });
  });
  const lens = parts.map((x) => len(x.p));
  const total = lens.reduce((s, l) => s + l, 0);
  let at = 0;
  return parts.map((x, i) => {
    const dur = (DRAW_MS * lens[i]!) / total;
    const s = { d: d(x.p), w: x.w, delay: DRAW_START + at, dur };
    at += dur;
    return s;
  });
})();

/** 朱の花丸。className で大きさを決める。小さく使うときは .hanamaru-mark（線を太くする） */
export function HanamaruMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 200 200" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        {STROKES.map((s, i) => (
          <path
            key={i}
            className="hanamaru__stroke"
            d={s.d}
            strokeWidth={s.w}
            pathLength={1}
            style={{ animationDelay: `${s.delay}ms`, animationDuration: `${s.dur}ms` }}
          />
        ))}
      </g>
    </svg>
  );
}

/** 朱の判子「よくできました」。縁と字は少しかすれさせる（SVG のフィルタ） */
export function YokuSeal({ className }: { className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg className={className} viewBox="0 0 120 120" aria-hidden="true">
      <defs>
        <filter id={`kasure-${id}`} x="-5%" y="-5%" width="110%" height="110%">
          {/* 大きめの雑音の明るいところを抜いて、朱肉ののらない所をところどころに作る */}
          <feTurbulence type="fractalNoise" baseFrequency="0.07" numOctaves="3" seed="7" result="patches" />
          <feColorMatrix in="patches" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -14 0 0 0 9.9" result="holes" />
          <feComposite in="SourceGraphic" in2="holes" operator="in" result="worn" />
          {/* 細かい雑音で縁を少しがたつかせる */}
          <feTurbulence type="fractalNoise" baseFrequency="0.6" numOctaves="1" seed="3" result="grain" />
          <feDisplacementMap in="worn" in2="grain" scale="2.2" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
      <g filter={`url(#kasure-${id})`} fill="none" stroke="currentColor">
        <circle cx="60" cy="60" r="55" strokeWidth="5" />
        <circle cx="60" cy="60" r="48" strokeWidth="1.6" />
        <g fill="currentColor" stroke="none" fontWeight="900" textAnchor="middle" dominantBaseline="central">
          <text x="60" y="43" fontSize="26">
            よく
          </text>
          <text x="60" y="76" fontSize="15.5" letterSpacing="-0.5">
            できました
          </text>
        </g>
      </g>
    </svg>
  );
}

/**
 * ぜんぶ完了の画面。どこを押しても閉じる・Esc で閉じる・閉じるにフォーカス。自動では閉じない。
 * total：今日済ませた件数、who：人ごとの件数
 */
export function HanamaruDialog({ total, who, onClose }: { total: number; who: [string, number][]; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // 開いた時点で決める（途中で設定が変わっても、出ている演出は変えない）
  const [motion] = useState(motionOk);
  const [confetti, setConfetti] = useState(motion);

  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
    if (!motion) return;
    const t = window.setTimeout(() => buzz([20, 60, 30]), IMPACT_MS);
    return () => clearTimeout(t);
  }, [motion]);

  return (
    <dialog
      ref={ref}
      className={`hanamaru-dialog${motion ? " is-moving" : ""}`}
      aria-modal="true"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={() => ref.current?.close()}
    >
      {confetti && <Confetti kind="cannons" delay={IMPACT_MS} onEnd={() => setConfetti(false)} />}
      <div className="hanamaru-dialog__paper">
        <div className="hanamaru">
          <HanamaruMark className="hanamaru__draw" />
          <YokuSeal className="hanamaru__seal" />
        </div>
        <h2 id={titleId} className="hanamaru-dialog__title">
          今日の当番、ぜんぶ完了！
        </h2>
        <p className="hanamaru-dialog__count">今日済ませたのは{total}件</p>
        {who.length > 0 && (
          <ul className="hanamaru-dialog__who" aria-label="人ごと">
            {who.map(([name, n]) => (
              <li key={name} aria-label={`${name} ${n}件`}>
                {name}
                <HanamaruMark className="hanamaru-mark" />
                {n}
              </li>
            ))}
          </ul>
        )}
        <button className="btn btn--primary hanamaru-dialog__close" autoFocus onClick={() => ref.current?.close()}>
          閉じる
        </button>
      </div>
    </dialog>
  );
}
