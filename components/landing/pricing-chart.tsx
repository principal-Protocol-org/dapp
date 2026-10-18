"use client";

import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";

const NS = "http://www.w3.org/2000/svg";

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const ease = (x: number) => {
  x = clamp(x);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
const seg = (t: number, a: number, b: number) => ease((t - a) / (b - a));
const lerp = (x: number, y: number, k: number) => x + (y - x) * k;

/** PT price in SY: discounted at the implied fixed rate over the time left to maturity. */
const ptPrice = (days: number, r: number) => 1 / Math.pow(1 + r, days / 365);
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const fmtDays = (d: number) => (d === 0 ? "At maturity" : `${d} days`);

/** Concentrated liquidity ranges around the implied rate: tight, wider, wide. */
const ranges = (r: number) =>
  (
    [
      [r - 0.004, r + 0.004],
      [r - 0.012, r + 0.02],
      [r - 0.03, r + 0.05],
    ] as const
  ).map(([a, b]) => [Math.max(0.0025, a), b] as const);

type FrameState = { k: number; lo: number; hi: number; a: number };

const DEFAULT_DAYS = 180;
const DEFAULT_RATE = 4.7;

/**
 * Time-aware pricing: PT converges to par as maturity approaches, YT decays to zero.
 * While in view the chart loops like a concentrated-liquidity AMM: draw the live curve inside a
 * tight range, widen it twice, release, repeat. The sliders move the marker and the readout.
 */
export function PricingChart({ children }: { children: React.ReactNode }) {
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [rate, setRate] = useState(DEFAULT_RATE);
  const svgRef = useRef<SVGSVGElement>(null);
  const valuesRef = useRef({ days: DEFAULT_DAYS, rate: DEFAULT_RATE });
  const redrawRef = useRef<() => void>(() => {});

  useEffect(() => {
    const chart = svgRef.current;
    if (!chart) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

    const C = { l: 56, r: 24, t: 24, b: 44, w: 640, h: 340, yMin: 0.92, yMax: 1.0 };
    const X = (d: number) => C.l + (1 - d / 365) * (C.w - C.l - C.r);
    const Y = (v: number) => C.t + (1 - (v - C.yMin) / (C.yMax - C.yMin)) * (C.h - C.t - C.b);
    const el = (tag: string, attrs: Record<string, string | number>, parent: Element = chart) => {
      const n = document.createElementNS(NS, tag) as SVGElement;
      for (const k in attrs) n.setAttribute(k, String(attrs[k]));
      parent.appendChild(n);
      return n;
    };
    const set = (n: Element, attrs: Record<string, string | number>) => {
      for (const k in attrs) n.setAttribute(k, String(attrs[k]));
    };

    const grid = el("g", {});
    const band = el("path", { class: "rng" });
    const edgeHi = el("path", { class: "rng-edge" });
    const edgeLo = el("path", { class: "rng-edge" });
    const parLine = el("line", { class: "par-line" });
    const parT = el("text", { class: "par-t" });
    parT.textContent = "PAR 1.00";
    const base = el("path", { class: "pt-base" });
    const glow = el("path", { class: "pt-glow" });
    const curve = el("path", { class: "pt-curve" });
    const head = el("circle", { class: "pt-head", r: 4.5 });
    const tLo = el("text", { class: "rng-t" });
    const tHi = el("text", { class: "rng-t" });
    const vline = el("line", { class: "mk-line" });
    const ytBar = el("line", { class: "mk-yt" });
    const dot = el("circle", { class: "mk-dot", r: 6 });

    const drawGrid = () => {
      grid.textContent = "";
      const span = C.yMax - C.yMin;
      const step = span > 0.1 ? 0.04 : 0.02;
      for (let v = C.yMax; v >= C.yMin - 1e-9; v -= step) {
        el("line", { class: "ax", x1: C.l, x2: C.w - C.r, y1: Y(v), y2: Y(v) }, grid);
        el("text", { class: "ax-t", x: C.l - 10, y: Y(v) + 4, "text-anchor": "end" }, grid).textContent = v.toFixed(2);
      }
      for (const d of [365, 270, 180, 90, 0]) {
        el("line", { class: "ax ax-v", x1: X(d), x2: X(d), y1: C.t, y2: C.h - C.b }, grid);
        el(
          "text",
          {
            class: "ax-t",
            x: X(d),
            y: C.h - C.b + 22,
            "text-anchor": d === 0 ? "end" : d === 365 ? "start" : "middle",
          },
          grid
        ).textContent = d === 0 ? "Maturity" : `${d}d`;
      }
    };
    const line = (r: number, from = 365, to = 0) => {
      let d = "";
      for (let t = from; t >= to - 1e-9; t -= 2.5) d += `${d ? "L" : "M"}${X(t).toFixed(1)} ${Y(ptPrice(t, r)).toFixed(1)}`;
      return d;
    };
    const yMinFor = (hi: number) => Math.min(0.92, ptPrice(365, hi) - 0.008);

    const frame = ({ k, lo, hi, a }: FrameState) => {
      const r = valuesRef.current.rate / 100;
      const d = valuesRef.current.days;
      C.yMin = yMinFor(hi);
      drawGrid();
      set(parLine, { x1: C.l, x2: C.w - C.r, y1: Y(1), y2: Y(1) });
      set(parT, { x: C.l + 6, y: Y(1) - 8 });
      const up = line(lo);
      const dn = line(hi);
      const back: string[] = [];
      for (let t = 0; t <= 365 + 1e-9; t += 2.5) back.push(`L${X(t).toFixed(1)} ${Y(ptPrice(t, hi)).toFixed(1)}`);
      band.setAttribute("d", `${up}${back.join("")}Z`);
      edgeHi.setAttribute("d", up);
      edgeLo.setAttribute("d", dn);
      for (const n of [band, edgeHi, edgeLo, tLo, tHi]) n.style.opacity = String(a);
      set(tLo, { x: X(365) + 8, y: Y(ptPrice(365, lo)) - 8 });
      tLo.textContent = pct(lo);
      set(tHi, { x: X(365) + 8, y: Y(ptPrice(365, hi)) + 16 });
      tHi.textContent = pct(hi);
      base.setAttribute("d", line(r));
      const end = 365 * (1 - k);
      const bold = k > 0 ? line(r, 365, end) : "";
      curve.setAttribute("d", bold);
      glow.setAttribute("d", bold);
      curve.style.opacity = glow.style.opacity = String(a);
      set(head, { cx: X(end), cy: Y(ptPrice(end, r)) });
      head.style.opacity = String(k > 0 && k < 1 ? a : 0);
      const pt = ptPrice(d, r);
      set(vline, { x1: X(d), x2: X(d), y1: C.t, y2: C.h - C.b });
      set(ytBar, { x1: X(d), x2: X(d), y1: Y(1), y2: Y(pt) });
      set(dot, { cx: X(d), cy: Y(pt) });
    };

    const CYCLE = 8200;
    const stateAt = (t: number): FrameState => {
      const R = ranges(valuesRef.current.rate / 100);
      const k = seg(t, 200, 1300);
      const w1 = seg(t, 2600, 3400);
      const w2 = seg(t, 4800, 5600);
      const a = seg(t, 0, 500) * (1 - seg(t, 7000, 7600));
      const lo = lerp(lerp(R[0][0], R[1][0], w1), R[2][0], w2);
      const hi = lerp(lerp(R[0][1], R[1][1], w1), R[2][1], w2);
      return { k, lo, hi: t > 7600 ? R[0][1] : hi, a };
    };
    const rest = (): FrameState => {
      const R = ranges(valuesRef.current.rate / 100);
      return { k: 1, lo: R[1][0], hi: R[1][1], a: 1 };
    };

    let looping = false;
    let t0 = 0;
    let raf = 0;
    const tick = (now: number) => {
      frame(stateAt((now - t0) % CYCLE));
      raf = requestAnimationFrame(tick);
    };
    const startLoop = () => {
      if (looping) return;
      looping = true;
      t0 = performance.now();
      raf = requestAnimationFrame(tick);
    };
    const stopLoop = () => {
      looping = false;
      cancelAnimationFrame(raf);
    };
    redrawRef.current = () => {
      if (!looping) frame(rest());
    };

    let io: IntersectionObserver | undefined;
    if (!reduce && "IntersectionObserver" in window) {
      const R = ranges(valuesRef.current.rate / 100);
      frame({ k: 0, lo: R[0][0], hi: R[0][1], a: 0 });
      io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) startLoop();
          else stopLoop();
        },
        { threshold: 0.35 }
      );
      io.observe(chart);
    } else {
      frame(rest());
    }

    return () => {
      stopLoop();
      io?.disconnect();
      redrawRef.current = () => {};
      chart.replaceChildren();
    };
  }, []);

  const r = rate / 100;
  const pt = ptPrice(days, r);

  return (
    <div className="grid items-start gap-12 min-[961px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <Card className="min-w-0">
        <div className="overflow-x-auto">
          <svg
            ref={svgRef}
            viewBox="0 0 640 340"
            role="img"
            aria-label="PT price in SY rising to par as maturity approaches"
            className="block h-auto w-full min-w-[480px]"
          />
        </div>
      </Card>
      <div className="grid gap-6">
        {children}
        <div className="grid gap-2">
          <div className="flex items-baseline justify-between">
            <span id="days-label" className="label">
              Days to maturity
            </span>
            <output className="font-mono text-[15px]/5 font-medium tabular-nums">{fmtDays(days)}</output>
          </div>
          <Slider
            aria-labelledby="days-label"
            min={0}
            max={365}
            step={1}
            value={[days]}
            onValueChange={([v]) => {
              setDays(v);
              valuesRef.current.days = v;
              redrawRef.current();
            }}
          />
        </div>
        <div className="grid gap-2">
          <div className="flex items-baseline justify-between">
            <span id="rate-label" className="label">
              Implied fixed rate
            </span>
            <output className="font-mono text-[15px]/5 font-medium tabular-nums">{pct(r)}</output>
          </div>
          <Slider
            aria-labelledby="rate-label"
            min={1}
            max={8}
            step={0.05}
            value={[rate]}
            onValueChange={([v]) => {
              setRate(v);
              valuesRef.current.rate = v;
              redrawRef.current();
            }}
          />
        </div>
        <div className="grid grid-cols-2 gap-4 rounded-md bg-surface-sunk p-4">
          <div className="grid gap-0.5">
            <span className="label">PT price</span>
            <b className="font-mono text-[26px]/8 font-medium tracking-[-0.02em] text-par tabular-nums">
              {pt.toFixed(4)}
            </b>
          </div>
          <div className="grid gap-0.5">
            <span className="label">YT price</span>
            <b className="font-mono text-[26px]/8 font-medium tracking-[-0.02em] text-coupon-ink tabular-nums">
              {(1 - pt).toFixed(4)}
            </b>
          </div>
        </div>
        <p className="text-[13px]/[19px] text-ink-muted">
          In SY units. The gold band is the pool&apos;s concentrated liquidity range, in implied APY. Illustration of
          the pricing model, starting from USDY&apos;s 4.70% underlying APY; live prices come from the pool.
        </p>
      </div>
    </div>
  );
}
