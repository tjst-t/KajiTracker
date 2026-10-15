// 今日の当番がぜんぶ済んだときの「皆済」：朱の大きな判子と紙吹雪。動きを減らすときは判子と文だけを静かに出す
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { buzz, motionOk } from "../celebrate";

/** 朱の判子「皆済」。縁と字は少しかすれさせる（SVG のフィルタ） */
export function KaisaiSeal({ className }: { className?: string }) {
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
        <circle cx="60" cy="60" r="55" strokeWidth="6" />
        <circle cx="60" cy="60" r="47" strokeWidth="1.8" />
        <text x="60" y="60" fill="currentColor" stroke="none" fontSize="40" fontWeight="900" textAnchor="middle" dominantBaseline="central" letterSpacing="-1">
          皆済
        </text>
      </g>
    </svg>
  );
}

/**
 * 皆済の画面。どこを押しても閉じる・Esc で閉じる・閉じるにフォーカス。自動では閉じない。
 * total：今日済ませた件数、breakdown：人ごとの内訳
 */
export function KaisaiDialog({ total, breakdown, onClose }: { total: number; breakdown: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const seal = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // 開いた時点で決める（途中で設定が変わっても、出ている演出は変えない）
  const [motion] = useState(motionOk);
  const [confetti, setConfetti] = useState(motion);

  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
    if (motion) buzz([20, 60, 30]);
  }, [motion]);

  return (
    <dialog
      ref={ref}
      className={`kaisai${motion ? " is-moving" : ""}`}
      aria-modal="true"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={() => ref.current?.close()}
    >
      {confetti && <Confetti from={seal} onEnd={() => setConfetti(false)} />}
      <div className="kaisai__body">
        <div ref={seal} className="kaisai__seal-wrap">
          <KaisaiSeal className="kaisai__seal" />
        </div>
        <h2 id={titleId} className="kaisai__title">
          今日の当番、ぜんぶ済みました
        </h2>
        <p className="kaisai__count">
          今日済ませたのは {total}件{breakdown && <span className="kaisai__who">{breakdown}</span>}
        </p>
        <button className="btn btn--primary kaisai__close" autoFocus onClick={() => ref.current?.close()}>
          閉じる
        </button>
      </div>
    </dialog>
  );
}

const COLORS = ["#2f4f6f", "#4f7f5a", "#b8432f", "#f4efe4"];
const DURATION = 2000;
/** 判子が押される瞬間（判子の動きの 0.5 秒のうち） */
const IMPACT_MS = 300;

type Bit = { x: number; y: number; vx: number; vy: number; w: number; h: number; rot: number; vr: number; flip: number; vf: number; color: string };

/** 紙吹雪：判子のまわりからはじけて、ひらひら回りながら落ちる。終わったら onEnd */
function Confetti({ from, onEnd }: { from: RefObject<HTMLElement | null>; onEnd: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const end = useRef(onEnd);
  end.current = onEnd;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      end.current();
      return;
    }
    const W = window.innerWidth;
    const H = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    // 小さな画面（古い端末）では粒を減らす
    const count = W * H < 400 * 700 ? 80 : 110;
    // 判子のまわりから。押す瞬間に測る（判子の箱は動かない。動くのは中の判子だけ）
    const burst = (): Bit[] => {
      const box = from.current?.getBoundingClientRect();
      const cx = box?.width ? box.left + box.width / 2 : W / 2;
      const cy = box?.width ? box.top + box.height / 2 : H * 0.4;
      const r = box?.width ? box.width * 0.42 : Math.min(W, 480) * 0.18;
      return Array.from({ length: count }, (_, i) => {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const speed = 4 + Math.random() * 7;
      return {
        x: cx + Math.cos(a) * r,
        y: cy + Math.sin(a) * r,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 4,
        w: 6 + Math.random() * 5,
        h: 4 + Math.random() * 4,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        flip: Math.random() * Math.PI,
        vf: 0.1 + Math.random() * 0.2,
        color: COLORS[i % COLORS.length]!,
      };
      });
    };
    let bits: Bit[] | null = null;

    let raf = 0;
    let start = 0;
    let last = 0;
    const frame = (now: number) => {
      if (!start) start = last = now;
      const t = now - start;
      if (t >= DURATION + IMPACT_MS) {
        end.current();
        return;
      }
      const k = Math.min((now - last) / 16.7, 3); // 間が空いても同じ速さで落ちる
      last = now;
      ctx.clearRect(0, 0, W, H);
      if (t >= IMPACT_MS) {
        bits ??= burst();
        const life = (t - IMPACT_MS) / DURATION;
        ctx.globalAlpha = life < 0.75 ? 1 : 1 - (life - 0.75) / 0.25;
        for (const b of bits) {
          b.vx *= 0.96 ** k;
          b.vy = b.vy * 0.96 ** k + 0.32 * k;
          b.x += b.vx * k + Math.sin(b.flip) * 0.6 * k;
          b.y += b.vy * k;
          b.rot += b.vr * k;
          b.flip += b.vf * k;
          ctx.setTransform(dpr, 0, 0, dpr, b.x * dpr, b.y * dpr);
          ctx.rotate(b.rot);
          ctx.scale(1, Math.cos(b.flip)); // 裏返りながら落ちる
          ctx.fillStyle = b.color;
          ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={ref} className="kaisai__confetti" aria-hidden="true" />;
}
