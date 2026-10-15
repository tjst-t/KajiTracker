// 紙吹雪。1枚の canvas に描く（古い端末でもカクつかないよう、DOM の粒は作らない）。
// burst：1件済ませたとき、判子のまわりから小さくはじけて 0.8 秒で消える。
// cannons：ぜんぶ完了のとき、画面の左下と右下から斜め上へ打ち上げ、ひらひら落ちて 3.5 秒ほどで消える。
import { useEffect, useRef } from "react";

/** 藍・若竹・朱・生成り。裏は少し濃く */
const COLORS = ["#2f4f6f", "#4f7f5a", "#b8432f", "#f4efe4"];
const shade = (hex: string, k: number) =>
  `rgb(${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * k)).join(" ")})`;
const BACKS = COLORS.map((c) => shade(c, 0.72));

type Bit = { x: number; y: number; vx: number; vy: number; w: number; h: number; rot: number; vr: number; flip: number; vf: number; c: number };

type Kind = "burst" | "cannons";
const LIFE: Record<Kind, number> = { burst: 800, cannons: 3500 };

function burstBits(x: number, y: number): Bit[] {
  const n = 10 + Math.floor(Math.random() * 5);
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
    const speed = 3 + Math.random() * 3;
    return {
      x: x + Math.cos(a) * 14,
      y: y + Math.sin(a) * 14,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed - 1.5,
      w: 6 + Math.random() * 3,
      h: 5 + Math.random() * 3,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      flip: Math.random() * Math.PI,
      vf: 0.15 + Math.random() * 0.2,
      c: i % COLORS.length,
    };
  });
}

function cannonBits(W: number, H: number): Bit[] {
  const reach = Math.min(Math.max(H / 844, 0.7), 1.3); // 画面の高さに合わせて打ち上げる強さを変える（上の 1〜5 割あたりまで届く）
  return Array.from({ length: 200 }, (_, i) => {
    const left = i % 2 === 0;
    // 斜め上（水平から 60〜82 度）。右からは鏡写し
    const a = ((60 + Math.random() * 22) * Math.PI) / 180;
    const speed = (25 + Math.random() * 10) * reach;
    const ribbon = Math.random() < 0.4; // 細長い短冊を混ぜる
    return {
      x: left ? -4 : W + 4,
      y: H + 4,
      vx: Math.cos(a) * speed * (left ? 1 : -1),
      vy: -Math.sin(a) * speed,
      w: ribbon ? 3.5 + Math.random() * 1.5 : 7 + Math.random() * 3,
      h: ribbon ? 13 + Math.random() * 6 : 6 + Math.random() * 3,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.25,
      flip: Math.random() * Math.PI,
      vf: 0.08 + Math.random() * 0.18,
      c: Math.floor(i / 2) % COLORS.length,
    };
  });
}

/**
 * 紙吹雪の canvas。delay ミリ秒待ってから、そのときの at() の位置（burst）か画面の両下（cannons）から出す。
 * 終わったら onEnd（外す側が canvas を消す）
 */
export function Confetti({ kind, delay = 0, at, onEnd }: { kind: Kind; delay?: number; at?: () => { x: number; y: number } | null; onEnd: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const end = useRef(onEnd);
  end.current = onEnd;
  const from = useRef(at);
  from.current = at;

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
    const life = LIFE[kind];
    const burst = kind === "burst";

    let bits: Bit[] | null = null;
    let raf = 0;
    let start = 0;
    let last = 0;
    const frame = (now: number) => {
      if (!start) start = last = now;
      const t = now - start - delay;
      if (t >= life) {
        end.current();
        return;
      }
      const k = Math.min((now - last) / 16.7, 3); // 間が空いても同じ速さで動く
      last = now;
      if (t >= 0) {
        if (!bits) {
          const p = from.current?.() ?? { x: W / 2, y: H / 2 };
          bits = burst ? burstBits(p.x, p.y) : cannonBits(W, H);
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const p = t / life;
        // 終わりのほうで薄く消す（burst は後ろ半分、cannons は最後の 2 割）
        const fade = burst ? 0.45 : 0.8;
        ctx.globalAlpha = p < fade ? 1 : 1 - (p - fade) / (1 - fade);
        const drag = burst ? 0.92 : 0.975;
        const g = burst ? 0.12 : 0.28;
        for (const b of bits) {
          b.vx *= drag ** k;
          b.vy = b.vy * drag ** k + g * k;
          // 落ちはじめたら空気でひらひら（落ちる速さを抑え、左右に揺らす）
          if (!burst && b.vy > 2.2) b.vy = 2.2 + (b.vy - 2.2) * 0.85 ** k;
          b.x += (b.vx + Math.sin(b.flip) * (burst ? 0.3 : 0.9)) * k;
          b.y += b.vy * k;
          b.rot += b.vr * k;
          b.flip += b.vf * k;
          const face = Math.cos(b.flip);
          ctx.setTransform(dpr, 0, 0, dpr, b.x * dpr, b.y * dpr);
          ctx.rotate(b.rot);
          ctx.scale(1, face); // 裏返りながら落ちる
          ctx.fillStyle = face >= 0 ? COLORS[b.c]! : BACKS[b.c]!;
          ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [kind, delay]);

  return <canvas ref={ref} className={`confetti confetti--${kind}`} aria-hidden="true" />;
}
