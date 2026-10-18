"use client";

import { useEffect, useRef } from "react";
import { Button, ButtonArrow } from "@/components/ui/button";
import { links } from "@/lib/content";
import { cn } from "@/lib/utils";
import { Container } from "./layout";

// Fades up once the intro sets `data-go` on the hero.
const reveal =
  "translate-y-[18px] opacity-0 transition-[opacity,translate] duration-700 ease-[cubic-bezier(.2,.7,.2,1)] group-data-[go]/hero:translate-y-0 group-data-[go]/hero:opacity-100 motion-reduce:transition-none";

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const ease = (x: number) => {
  x = clamp(x);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
const seg = (t: number, a: number, b: number) => ease((t - a) / (b - a));

/**
 * Full-screen intro, the brand's signature motion: a coin is traced, its diameter drawn,
 * the two halves fill, then open into the PT and YT half-moons. Clicking the coin replays it.
 */
export function Hero() {
  const heroRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const cueRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const hero = heroRef.current;
    const canvas = canvasRef.current;
    const slot = slotRef.current;
    const labels = labelsRef.current;
    const cue = cueRef.current;
    const c = canvas?.getContext("2d");
    if (!hero || !canvas || !slot || !labels || !cue || !c) return;

    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const tok = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

    const END = 3100;
    let W = 0;
    let H = 0;
    let dpr = 1;
    let t0 = performance.now();
    let running = false;
    let raf = 0;
    let alive = true;

    const fit = () => {
      dpr = Math.min(2, devicePixelRatio || 1);
      const r = hero.getBoundingClientRect();
      W = r.width;
      H = r.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      const R1 = Math.round(Math.max(52, Math.min(112, H * 0.12, W * 0.2)));
      slot.style.setProperty("--slot-h", `${R1 * 2}px`);
      slot.style.setProperty("--slot-w", `${R1 * 2 + R1 * 0.3}px`);
      labels.style.setProperty("--lab-w", `${R1}px`);
      labels.style.setProperty("--lab-gap", `${Math.max(R1 * 0.3, 40)}px`);
    };

    const halves = (x: number, y: number, r: number, gap: number, a: number) => {
      c.globalAlpha = a;
      c.beginPath();
      c.moveTo(x - gap, y - r);
      c.ellipse(x - gap, y, r, r, 0, -Math.PI / 2, Math.PI / 2, true);
      c.closePath();
      c.fillStyle = tok("--par");
      c.fill();
      c.beginPath();
      c.moveTo(x + gap, y - r);
      c.ellipse(x + gap, y, r, r, 0, -Math.PI / 2, Math.PI / 2, false);
      c.closePath();
      c.fillStyle = tok("--coupon");
      c.fill();
      c.globalAlpha = 1;
    };

    const draw = (t: number) => {
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, H);
      const hr = hero.getBoundingClientRect();
      const sr = slot.getBoundingClientRect();
      const fx = sr.left - hr.left + sr.width / 2;
      const fy = sr.top - hr.top + sr.height / 2;
      const R1 = sr.height / 2;
      // In place: trace the coin, draw its diameter, fill the two halves (pale → full), then open them.
      const q1 = seg(t, 0, 1000);
      const q2 = seg(t, 1000, 1500);
      const fill = seg(t, 1500, 2100);
      const out = seg(t, 1900, 2200);
      const sp = seg(t, 2100, 3000);
      const gap = R1 * 0.14 * sp;
      if (fill > 0) halves(fx, fy, R1, gap, 0.18 + 0.82 * fill);
      if (out < 1) {
        c.globalAlpha = 1 - out;
        c.strokeStyle = tok("--ink");
        c.lineWidth = 1.5;
        c.beginPath();
        c.arc(fx, fy, R1, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * q1);
        c.stroke();
        if (q2 > 0) {
          c.beginPath();
          c.moveTo(fx, fy - R1);
          c.lineTo(fx, fy - R1 + 2 * R1 * q2);
          c.stroke();
        }
        c.globalAlpha = 1;
      }
      if (t >= 2700 && !hero.hasAttribute("data-go")) hero.setAttribute("data-go", "");
    };

    const loop = (now: number) => {
      const t = now - t0;
      draw(t);
      if (t < END) raf = requestAnimationFrame(loop);
      else running = false;
    };
    const play = () => {
      if (running) return;
      running = true;
      hero.removeAttribute("data-go");
      t0 = performance.now();
      raf = requestAnimationFrame(loop);
    };
    const settle = () => {
      if (!running) draw(END);
    };

    fit();
    if (reduce) draw(END);
    else play();

    const onResize = () => {
      fit();
      settle();
    };
    const onReplay = () => {
      if (!reduce) play();
    };
    const onScroll = () => cue.toggleAttribute("data-gone", scrollY > 24);

    addEventListener("resize", onResize);
    addEventListener("scroll", onScroll, { passive: true });
    slot.addEventListener("click", onReplay);
    onScroll();

    // Redraw with the new colours when the theme class changes on <html>.
    const themeObserver = new MutationObserver(settle);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    document.fonts?.ready.then(() => {
      if (alive) settle();
    });

    return () => {
      alive = false;
      running = false;
      cancelAnimationFrame(raf);
      removeEventListener("resize", onResize);
      removeEventListener("scroll", onScroll);
      slot.removeEventListener("click", onReplay);
      themeObserver.disconnect();
    };
  }, []);

  return (
    <section
      ref={heroRef}
      id="hero"
      aria-labelledby="hero-title"
      className="group/hero relative grid min-h-[calc(100svh-64px)] place-items-center overflow-hidden pt-8 pb-12 text-center"
    >
      <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 block size-full" />
      <Container className="relative z-1 grid justify-items-center">
        <div
          ref={slotRef}
          role="img"
          aria-label="Principal: one token, split into a fixed half and a variable half"
          title="Replay"
          className="h-[var(--slot-h,150px)] w-[var(--slot-w,168px)] cursor-pointer"
        />
        <div
          ref={labelsRef}
          aria-hidden="true"
          className={cn(
            reveal,
            "mt-[18px] flex justify-center gap-[var(--lab-gap,40px)] font-mono text-xs/4 font-medium tracking-[.07em] text-ink-muted uppercase"
          )}
        >
          <span className="w-[var(--lab-w,80px)] text-center whitespace-nowrap">PT · Fixed</span>
          <span className="w-[var(--lab-w,80px)] text-center whitespace-nowrap">YT · Variable</span>
        </div>
        <h1
          id="hero-title"
          className="mt-[clamp(24px,4vh,44px)] font-display text-[clamp(38px,5.6vw,80px)] leading-[1.04] tracking-[-0.02em]"
        >
          <span className="block min-[760px]:whitespace-nowrap">Yield tokenization for</span>{" "}
          <span className="block min-[760px]:whitespace-nowrap">
            Stellar <em className="text-coupon-ink not-italic">real&#8209;world assets.</em>
          </span>
        </h1>
        <p className="mt-6 max-w-[46ch] text-[clamp(17px,1.5vw,20px)] leading-normal text-ink-muted">
          Lock in fixed yield or trade future yield on regulated RWAs without compromising compliance.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button asChild size="lg">
            <a href={links.app}>
              Launch app <ButtonArrow />
            </a>
          </Button>
          <Button asChild variant="secondary" size="lg">
            <a href={links.github} target="_blank" rel="noopener">
              Read the protocol
            </a>
          </Button>
        </div>
      </Container>
      <span
        ref={cueRef}
        aria-hidden="true"
        className={cn(
          reveal,
          "absolute inset-x-0 bottom-[22px] z-1 text-center font-mono text-[11px]/4 font-medium tracking-[.08em] text-ink-muted uppercase group-data-[go]/hero:delay-240 data-[gone]:opacity-0! data-[gone]:delay-0! data-[gone]:duration-400!"
        )}
      >
        Scroll
      </span>
    </section>
  );
}
