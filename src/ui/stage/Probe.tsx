/**
 * Cell probe (spec §5 "Cell probe"): a 1 px accent outline on the hovered cell (art-area layer)
 * and a tag beside it, "C035 R22 [d] L 0.83" (viewport layer). The tag sits on the emptier side of
 * the row and never covers the cell; it flips when it would leave the visible frame. Both move by
 * transform only, fade in 80 ms after the pointer arrives (CSS), and hide while a slider drags.
 */
import { useLayoutEffect, useRef } from 'react';
import { probeCell, useStageLayout } from '../../app/engineHost';
import { useStore, type Probe } from '../../state/store';
import { clamp } from '../kit';
import { visibleGrid, type StageLayout } from './layout';

const GAP = 12;
const TAG_H = 24;

export function ProbeOutline() {
  const layout = useStageLayout();
  const probe = useStore((s) => s.view.probe);
  if (!layout || !probe) return null;
  const { area } = layout.box;
  const x = layout.x - area.x + probe.col * layout.cellW;
  const y = layout.y - area.y + probe.row * layout.cellH;
  return (
    <div
      className="probe"
      aria-hidden="true"
      style={{ transform: `translate(${x}px, ${y}px)`, width: layout.cellW, height: layout.cellH }}
    />
  );
}

export function ProbeTag() {
  const layout = useStageLayout();
  const probe = useStore((s) => s.view.probe);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !layout || !probe) return;
    const { x, y } = placeTag(layout, probe, el.offsetWidth);
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  });

  if (!layout || !probe) return null;
  return (
    <div ref={ref} className="tag" aria-hidden="true">
      <span>
        C<b>{String(probe.col).padStart(3, '0')}</b> R<b>{String(probe.row).padStart(2, '0')}</b>
      </span>
      <span className="gl">{probe.char === ' ' ? ' ' : probe.char}</span>
      <span>
        L <b>{probe.L.toFixed(2)}</b>
      </span>
    </div>
  );
}

/** Left or right of the cell, whichever fits the visible frame and holds fewer glyphs. */
function placeTag(layout: StageLayout, probe: Probe, width: number): { x: number; y: number } {
  const vis = visibleGrid(layout);
  const cellX = layout.x + probe.col * layout.cellW;
  const cellY = layout.y + probe.row * layout.cellH;
  const leftX = cellX - GAP - width;
  const rightX = cellX + layout.cellW + GAP;
  const fitsLeft = leftX >= vis.x;
  const fitsRight = rightX + width <= vis.x + vis.width;
  let side: 'left' | 'right';
  if (fitsLeft && fitsRight) {
    const span = Math.ceil((width + GAP) / layout.cellW);
    side = inkCount(probe, -span) <= inkCount(probe, span) ? 'left' : 'right';
  } else if (fitsLeft || fitsRight) {
    side = fitsLeft ? 'left' : 'right';
  } else {
    side = cellX - vis.x > vis.x + vis.width - cellX ? 'left' : 'right';
  }
  const y = clamp(cellY + layout.cellH / 2 - TAG_H / 2, 0, layout.box.height - TAG_H);
  return { x: side === 'left' ? leftX : rightX, y };
}

/** Glyphs (non-space cells) in `span` cells beside the probe on its row; negative spans look left. */
function inkCount(probe: Probe, span: number): number {
  const from = span < 0 ? Math.max(0, probe.col + span) : probe.col + 1;
  const to = span < 0 ? probe.col : probe.col + 1 + span;
  let n = 0;
  for (let c = from; c < to; c++) if (probeCell(c, probe.row)?.char.trim()) n++;
  return n;
}
