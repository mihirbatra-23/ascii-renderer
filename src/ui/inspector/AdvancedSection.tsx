/**
 * Advanced (collapsed): what the mode adds beyond Tone (Shape: dither amount and shape
 * contrast, the engine's shapeSharpness; Halftone: dot angle and shape), the font for the
 * glyph modes, line height with the resulting cell, and auto levels.
 */
import { FONTS } from '../../engine/fonts';
import type { FontId, HalftoneShape } from '../../engine/types';
import { useStore } from '../../state/store';
import { Disclosure, Select } from '../kit';
import { LabelledRow, ParamSlider, ParamSwitch, store, useRememberedOpen } from './controls';
import { DOT_SHAPE_LABELS, TIPS } from './copy';
import { useCellGeometry } from './glyphInfo';

const FONT_IDS: readonly FontId[] = ['jetbrains-mono', 'ibm-plex-mono', 'geist-mono'];
const FONT_OPTIONS = FONT_IDS.map((id) => ({ value: id, label: FONTS[id].label }));
const DOT_SHAPES: readonly HalftoneShape[] = ['round', 'square', 'diamond', 'line'];
const DOT_OPTIONS = DOT_SHAPES.map((s) => ({ value: s, label: DOT_SHAPE_LABELS[s] }));

export function AdvancedSection() {
  const mode = useStore((s) => s.params.mode);
  const [open, setOpen] = useRememberedOpen('advanced');
  const glyphMode = mode === 'shape' || mode === 'ramp';
  return (
    <Disclosure title="Advanced" tab="adjust" open={open} onOpenChange={setOpen}>
      <div className="rows">
        {mode === 'shape' && (
          <>
            <ParamSlider param="dither" label="Dither" tooltip={TIPS.dither} />
            <ParamSlider param="shapeSharpness" label="Shape contrast" tooltip={TIPS.shapeSharpness} />
          </>
        )}
        {mode === 'halftone' && (
          <>
            <ParamSlider param="halftoneAngle" label="Dot angle" tooltip={{ body: TIPS.halftoneAngle, unit: '°' }} />
            <DotShapeRow />
          </>
        )}
        {glyphMode && <FontRow />}
        <ParamSlider param="lineHeight" label="Line height" tooltip={TIPS.lineHeight} />
      </div>
      <CellFacts />
      <ParamSwitch param="autoLevels" label="Auto levels" tooltip={TIPS.autoLevels} />
    </Disclosure>
  );
}

function FontRow() {
  const font = useStore((s) => s.params.font);
  return (
    <LabelledRow label="Font">
      {() => <Select label="Font" value={font} options={FONT_OPTIONS} onChange={(v) => store().setParam('font', v)} />}
    </LabelledRow>
  );
}

function DotShapeRow() {
  const shape = useStore((s) => s.params.halftoneShape);
  return (
    <LabelledRow label="Dot shape">
      {() => <Select label="Dot shape" value={shape} options={DOT_OPTIONS} onChange={(v) => store().setParam('halftoneShape', v)} />}
    </LabelledRow>
  );
}

/** The cell is derived (font advance × line height), not set: shown, not edited. */
function CellFacts() {
  const cell = useCellGeometry();
  return (
    <div className="facts">
      <span>
        Cell <b>{cell.cellW} × {cell.cellH}</b> px
      </span>
      <span>
        Font <b>{Number(cell.fontSize.toFixed(2))}</b> px
      </span>
    </div>
  );
}
