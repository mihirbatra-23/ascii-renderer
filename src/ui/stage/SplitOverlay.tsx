/**
 * Overlays in the art area (positioned in its coordinates, clipped by it):
 *
 *   <TransparencyChecker />   the checker under the grid while Export previews a transparent
 *                      background (the engine then leaves the paper transparent)
 *   <GridFrame />      the 1 px --line-2 edge of the output frame
 *   <SplitOverlay />   Split compare (spec §4.6): divider, a 32 px round handle (role="slider";
 *                      ← → 1 %, Shift 10 %, Home / End) and the chips naming each side:
 *                      "Source" (or "Ramp" when comparing with a Ramp render) and "Shape"
 *                      ("+ contour lines" against Ramp while the edge layer is on).
 *                      The engine draws the left side itself (Viewport.compare, compareWith).
 */
import type { KeyboardEvent, PointerEvent } from 'react';
import { getStageLayout, useStageLayout } from '../../app/engineHost';
import { useStore } from '../../state/store';
import { useTransparentPreview } from '../export/transparency';
import { hasEdgeLayer } from '../inspector/copy';
import { Icon } from '../icons';
import { clamp, MODE_LABELS } from '../kit';
import { setAdjusting } from '../kit/util';
import { effectiveCompare } from './compare';
import { visibleGrid } from './layout';

export function TransparencyChecker() {
  const layout = useStageLayout();
  const on = useTransparentPreview();
  if (!layout || !on) return null;
  const { area } = layout.box;
  return (
    <div
      className="chk"
      aria-hidden="true"
      style={{ transform: `translate(${layout.x - area.x}px, ${layout.y - area.y}px)`, width: layout.width, height: layout.height }}
    />
  );
}

export function GridFrame() {
  const layout = useStageLayout();
  if (!layout) return null;
  const { area } = layout.box;
  return (
    <div
      className="frm"
      aria-hidden="true"
      style={{ transform: `translate(${layout.x - area.x}px, ${layout.y - area.y}px)`, width: layout.width, height: layout.height }}
    />
  );
}

const KEY_STEPS: Record<string, number> = { ArrowLeft: -0.01, ArrowDown: -0.01, ArrowRight: 0.01, ArrowUp: 0.01, PageDown: -0.1, PageUp: 0.1 };

function setSplit(v: number) {
  useStore.getState().setView({ split: Math.round(clamp(v, 0, 1) * 1000) / 1000 });
}

export function SplitOverlay() {
  const layout = useStageLayout();
  const on = useStore((s) => s.view.mode === 'split');
  const split = useStore((s) => s.view.split);
  const mode = useStore((s) => s.params.mode);
  // The Ramp render on the left never has contour strokes; say so on the right when the current
  // mode draws them, or "Ramp | Ramp" would read as two identical sides.
  const contours = useStore((s) => s.params.edges && hasEdgeLayer(s.params.mode));
  const compareWith = useStore((s) => effectiveCompare(s.view, s.params));
  if (!layout || !on) return null;

  const { area } = layout.box;
  const vis = visibleGrid(layout);
  const x = layout.x - area.x + split * layout.width;
  const top = vis.y - area.y;
  const pct = Math.round(split * 100);

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    // The same flag a slider drag sets: the cell probe, its tag and the ruler marks hide.
    setAdjusting('drag');
  };
  const endDrag = () => setAdjusting(null);
  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const l = getStageLayout();
    const vp = e.currentTarget.closest('.vp');
    if (!l || !vp || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    setSplit((e.clientX - vp.getBoundingClientRect().left - l.x) / l.width);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = KEY_STEPS[e.key];
    if (step !== undefined) setSplit(split + step * (e.shiftKey && Math.abs(step) < 0.1 ? 10 : 1));
    else if (e.key === 'Home') setSplit(0);
    else if (e.key === 'End') setSplit(1);
    else return;
    e.preventDefault();
  };

  const left = Math.max(layout.x, area.x) - area.x + 12;
  const right = area.x + area.width - Math.min(layout.x + layout.width, area.x + area.width) + 12;
  return (
    <div className="split">
      <span className="div" style={{ transform: `translate(${x}px, ${top}px)`, height: vis.height }} />
      <button
        type="button"
        className="knob"
        role="slider"
        aria-label="Split position"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${pct} percent ${compareWith === 'ramp' ? 'Ramp' : 'source'}`}
        style={{ transform: `translate(${x}px, ${top + vis.height / 2}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={onKeyDown}
      >
        <Icon name="arrows-lr" />
      </button>
      <span className="chip l" style={{ transform: `translate(${left}px, ${top + 12}px)` }}>
        {compareWith === 'ramp' ? MODE_LABELS.ramp : 'Source'}
      </span>
      <span className="chip r" style={{ right, transform: `translateY(${top + 12}px)` }}>
        {MODE_LABELS[mode]}
        {contours && compareWith === 'ramp' && ' + contour lines'}
      </span>
    </div>
  );
}
