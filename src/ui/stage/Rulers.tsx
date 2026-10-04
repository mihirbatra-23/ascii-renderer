/**
 * Rulers in grid units (spec §5 "Rulers"): one 2D canvas per axis, redrawn only when the layout
 * or fonts change. Ticks: 7 px every 10 units (--tick-on), 4 px every 5 (--tick); numerals
 * 10 px mono --tx-3, thinned to 10 / 20 / 50 / 100… so they stay ≥ 40 px apart. The rulers hug the
 * frame and pin to the viewport edge when the grid is zoomed past it. The accent cursor ticks are
 * separate one-cell elements moved by transform.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStageLayout } from '../../app/engineHost';
import { useStore } from '../../state/store';
import { clamp } from '../kit';
import type { StageLayout } from './layout';

const X_H = 18;
const Y_W = 22;
/** Gap between a ruler and the frame edge it measures. */
const X_OFF = 24;
const Y_OFF = 28;
const LABEL_STEPS = [10, 20, 50, 100, 200, 500, 1000];
const MIN_LABEL_GAP = 40;

interface Palette {
  label: string;
  tick: string;
  tickOn: string;
}

export function Rulers() {
  const layout = useStageLayout();
  const show = useStore((s) => s.view.rulers && !s.exportUi.open);
  const fontsReady = useFontsReady();
  const xRef = useRef<HTMLCanvasElement>(null);
  const yRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    if (!layout || !show || !xRef.current || !yRef.current) return;
    const css = getComputedStyle(document.documentElement);
    const palette: Palette = {
      label: css.getPropertyValue('--tx-3').trim(),
      tick: css.getPropertyValue('--tick').trim(),
      tickOn: css.getPropertyValue('--tick-on').trim(),
    };
    drawX(xRef.current, layout, palette);
    drawY(yRef.current, layout, palette);
  }, [layout, show, fontsReady]);

  if (!layout || !show) return null;
  const { box } = layout;
  const top = Math.max(0, clamp(layout.y, box.area.y, box.area.y + box.area.height) - X_OFF);
  const left = Math.max(0, clamp(layout.x, box.area.x, box.area.x + box.area.width) - Y_OFF);
  return (
    <>
      <div className="ruler x" aria-hidden="true" style={{ left: box.area.x, width: box.width - box.area.x, transform: `translateY(${top}px)` }}>
        <canvas ref={xRef} />
        <CursorTick axis="x" layout={layout} />
      </div>
      <div className="ruler y" aria-hidden="true" style={{ top: box.area.y, height: box.area.height, transform: `translateX(${left}px)` }}>
        <canvas ref={yRef} />
        <CursorTick axis="y" layout={layout} />
      </div>
    </>
  );
}

function CursorTick({ axis, layout }: { axis: 'x' | 'y'; layout: StageLayout }) {
  const probe = useStore((s) => s.view.probe);
  if (!probe) return null;
  const { area } = layout.box;
  const style =
    axis === 'x'
      ? { width: layout.cellW, transform: `translateX(${layout.x - area.x + probe.col * layout.cellW}px)` }
      : { height: layout.cellH, transform: `translateY(${layout.y - area.y + probe.row * layout.cellH}px)` };
  return <i className="mk" style={style} />;
}

/** Re-render once the mono face is ready, so the first ruler is not drawn in a fallback font. */
function useFontsReady(): boolean {
  const [ready, setReady] = useState(() => document.fonts.check('10px "Geist Mono"'));
  useEffect(() => {
    if (ready) return;
    let live = true;
    void document.fonts.load('10px "Geist Mono"').then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [ready]);
  return ready;
}

function steps(unit: number): { label: number; major: number; minor: number } {
  const label = LABEL_STEPS.find((s) => s * unit >= MIN_LABEL_GAP) ?? LABEL_STEPS[LABEL_STEPS.length - 1];
  const major = 10 * unit >= 6 ? 10 : label;
  const minor = major === 10 && 5 * unit >= 4 ? 5 : major;
  return { label, major, minor };
}

function sizeCanvas(canvas: HTMLCanvasElement, width: number, height: number, dpr: number): CanvasRenderingContext2D | null {
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = '10px "Geist Mono", ui-monospace, monospace';
  return ctx;
}

/** Ticks and numerals for units `first…count` along one axis, clipped to [lo, hi] (canvas px). */
function eachUnit(origin: number, unit: number, count: number, step: number, lo: number, hi: number, fn: (u: number, at: number) => void) {
  const first = Math.max(0, Math.ceil((lo - origin) / unit / step) * step);
  for (let u = first; u <= count; u += step) {
    const at = Math.round(origin + u * unit);
    if (at > hi) break;
    fn(u, at);
  }
}

function drawX(canvas: HTMLCanvasElement, layout: StageLayout, p: Palette) {
  const { box } = layout;
  const width = box.width - box.area.x;
  const ctx = sizeCanvas(canvas, width, X_H, box.dpr);
  if (!ctx) return;
  const origin = layout.x - box.area.x;
  const lo = Math.max(0, origin);
  const hi = Math.min(width, origin + layout.width);
  const s = steps(layout.cellW);
  ctx.fillStyle = p.tick;
  eachUnit(origin, layout.cellW, layout.cols, s.minor, lo, hi, (u, x) => {
    if (u % s.major) ctx.fillRect(x, X_H - 4, 1, 4);
  });
  ctx.fillStyle = p.tickOn;
  eachUnit(origin, layout.cellW, layout.cols, s.major, lo, hi, (_, x) => ctx.fillRect(x, X_H - 7, 1, 7));
  ctx.fillStyle = p.label;
  ctx.textBaseline = 'top';
  eachUnit(origin, layout.cellW, layout.cols - 1, s.label, lo, hi, (u, x) => ctx.fillText(String(u), x + 3, 0));
}

function drawY(canvas: HTMLCanvasElement, layout: StageLayout, p: Palette) {
  const { box } = layout;
  const height = box.area.height;
  const ctx = sizeCanvas(canvas, Y_W, height, box.dpr);
  if (!ctx) return;
  const origin = layout.y - box.area.y;
  const lo = Math.max(0, origin);
  const hi = Math.min(height, origin + layout.height);
  const s = steps(layout.cellH);
  ctx.fillStyle = p.tick;
  eachUnit(origin, layout.cellH, layout.rows, s.minor, lo, hi, (u, y) => {
    if (u % s.major) ctx.fillRect(Y_W - 4, y, 4, 1);
  });
  ctx.fillStyle = p.tickOn;
  eachUnit(origin, layout.cellH, layout.rows, s.major, lo, hi, (_, y) => ctx.fillRect(Y_W - 7, y, 7, 1));
  ctx.fillStyle = p.label;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'right';
  // Numerals sit left of the major ticks; three-digit rows (≥ 100) do not fit there, so they slide
  // right, under their tick line and clear of the 4 px minor ticks, instead of being clipped.
  eachUnit(origin, layout.cellH, layout.rows - 1, s.label, lo, hi, (u, y) => {
    const text = String(u);
    ctx.fillText(text, ctx.measureText(text).width > Y_W - 10 ? Y_W - 4 : Y_W - 9, y + 1);
  });
}
