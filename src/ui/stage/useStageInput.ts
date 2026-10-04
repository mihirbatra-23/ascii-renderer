/**
 * Pointer, wheel and touch input on the stage viewport (.vp), all outside React state:
 *
 *   hover        the cell probe (store.view.probe), re-read after every draw so it follows video
 *                frames and zoom changes without the pointer moving. engine.probe answers from
 *                an asynchronous readback; while a newer one is in flight it is asked again on
 *                the next animation frame, so the tag settles on the current picture
 *   wheel        zoom around the cursor; trackpad pinch arrives as ctrl+wheel; sideways scroll pans
 *   drag         pans when zoomed (not in 'fit')
 *   two fingers  pinch-zoom and pan
 *   double-click fit
 */
import { useEffect, type RefObject } from 'react';
import { getStageLayout, onDraw, probeCell } from '../../app/engineHost';
import { useStore, type Probe } from '../../state/store';
import { clamp } from '../kit';
import { cellAt } from './layout';
import { fitView, panBy, zoomBy } from './viewActions';

/** Elements inside .vp that handle their own pointer input. */
const OWN_INPUT = 'button,a,input,[role="slider"]';

interface Point {
  x: number;
  y: number;
}

export function useStageInput(vpRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    let hover: Point | null = null;
    let drag: { id: number; x: number; y: number } | null = null;
    const touches = new Map<number, Point>();
    let pinch: { dist: number; mid: Point } | null = null;
    let recheck = 0;
    /** Re-asks left for this pointer position: a readback takes a frame or two, never more. */
    let rechecks = 0;
    const MAX_RECHECKS = 10;

    const local = (e: { clientX: number; clientY: number }): Point => {
      const r = vp.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const updateProbe = () => {
      const s = useStore.getState();
      const layout = getStageLayout();
      const active = hover && layout && !drag && !pinch && !s.exportUi.open && s.view.mode !== 'source';
      const cell = active ? cellAt(layout, hover!.x, hover!.y) : null;
      const hit = cell && probeCell(cell.col, cell.row);
      const probe: Probe | null = hit ? { col: hit.col, row: hit.row, char: hit.char, L: Math.round(hit.tone * 100) / 100 } : null;
      if (!sameProbe(s.view.probe, probe)) s.setView({ probe });
      // No answer yet, or one from the previous analysis: the readback lands within a frame or two.
      if (cell && (!hit || hit.pending) && !recheck && rechecks > 0) {
        rechecks--;
        recheck = requestAnimationFrame(() => {
          recheck = 0;
          updateProbe();
        });
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (drag?.id === e.pointerId) {
        panBy(e.clientX - drag.x, e.clientY - drag.y);
        drag.x = e.clientX;
        drag.y = e.clientY;
        return;
      }
      if (touches.has(e.pointerId)) return onTouchMove(e);
      if (e.pointerType === 'touch') return;
      hover = local(e);
      rechecks = MAX_RECHECKS;
      updateProbe();
    };

    const onPointerLeave = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      hover = null;
      updateProbe();
    };

    const onPointerDown = (e: PointerEvent) => {
      if ((e.target as Element).closest(OWN_INPUT)) return;
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, local(e));
        vp.setPointerCapture(e.pointerId);
        if (touches.size === 2) startPinch();
        return;
      }
      if (e.button !== 0 || useStore.getState().view.zoom === 'fit') return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      vp.setPointerCapture(e.pointerId);
      vp.classList.add('is-panning');
      updateProbe();
    };

    const onPointerUp = (e: PointerEvent) => {
      if (drag?.id === e.pointerId) {
        drag = null;
        vp.classList.remove('is-panning');
      }
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
    };

    const startPinch = () => {
      const [a, b] = [...touches.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    };

    const onTouchMove = (e: PointerEvent) => {
      const prev = touches.get(e.pointerId)!;
      const next = local(e);
      touches.set(e.pointerId, next);
      if (pinch && touches.size === 2) {
        const [a, b] = [...touches.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (pinch.dist > 0) zoomBy(dist / pinch.dist, mid);
        if (useStore.getState().view.zoom !== 'fit') panBy(mid.x - pinch.mid.x, mid.y - pinch.mid.y);
        pinch = { dist, mid };
      } else if (touches.size === 1 && useStore.getState().view.zoom !== 'fit') {
        panBy(next.x - prev.x, next.y - prev.y);
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (!getStageLayout()) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vp.clientHeight : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      if (!e.ctrlKey && !e.metaKey && Math.abs(dx) > Math.abs(dy)) {
        if (useStore.getState().view.zoom !== 'fit') panBy(-dx, 0);
        return;
      }
      // Pinch gestures report small deltas as ctrl+wheel; mouse wheels report ~100 px notches.
      const k = e.ctrlKey ? 0.01 : 0.0015;
      zoomBy(clamp(Math.exp(-dy * k), 0.5, 2), local(e));
    };

    const onDoubleClick = (e: MouseEvent) => {
      if (!(e.target as Element).closest(OWN_INPUT)) fitView();
    };

    vp.addEventListener('pointermove', onPointerMove);
    vp.addEventListener('pointerleave', onPointerLeave);
    vp.addEventListener('pointerdown', onPointerDown);
    vp.addEventListener('pointerup', onPointerUp);
    vp.addEventListener('pointercancel', onPointerUp);
    vp.addEventListener('wheel', onWheel, { passive: false });
    vp.addEventListener('dblclick', onDoubleClick);
    const offDraw = onDraw(() => {
      if (!hover) return;
      rechecks = MAX_RECHECKS;
      updateProbe();
    });
    return () => {
      vp.removeEventListener('pointermove', onPointerMove);
      vp.removeEventListener('pointerleave', onPointerLeave);
      vp.removeEventListener('pointerdown', onPointerDown);
      vp.removeEventListener('pointerup', onPointerUp);
      vp.removeEventListener('pointercancel', onPointerUp);
      vp.removeEventListener('wheel', onWheel);
      vp.removeEventListener('dblclick', onDoubleClick);
      cancelAnimationFrame(recheck);
      offDraw();
      useStore.getState().setView({ probe: null });
    };
  }, [vpRef]);
}

function sameProbe(a: Probe | null, b: Probe | null): boolean {
  if (a === b) return true;
  return !!a && !!b && a.col === b.col && a.row === b.row && a.char === b.char && a.L === b.L;
}
