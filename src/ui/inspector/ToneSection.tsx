/**
 * Tone: brightness (bipolar), contrast, gamma, then the one control the mode adds (Shape: edge
 * sharpness; Ramp: dither amount; Braille and Blocks: dither pattern), and Invert (I, in its tip), with a
 * one-click suggestion when a still would otherwise be mostly dense glyphs (./lightImage).
 */
import type { DitherPattern } from '../../engine/types';
import { useStore } from '../../state/store';
import { IconButton, Section, Segmented } from '../kit';
import { LabelledRow, ParamSlider, ParamSwitch, store } from './controls';
import { DITHER_LABELS, TIPS } from './copy';
import { useInvertHint } from './useInvertHint';

const PATTERNS: readonly DitherPattern[] = ['none', 'ordered', 'noise'];

export function ToneSection() {
  const mode = useStore((s) => s.params.mode);
  return (
    <Section
      title="Tone"
      tab="adjust"
      action={<IconButton icon="reset" label="Reset tone" size="sm" onClick={() => store().resetParams('tone')} />}
    >
      <div className="rows">
        <ParamSlider param="brightness" label="Brightness" tooltip={TIPS.brightness} />
        <ParamSlider param="contrast" label="Contrast" tooltip={TIPS.contrast} />
        <ParamSlider param="gamma" label="Gamma" tooltip={TIPS.gamma} />
        {mode === 'shape' && <ParamSlider param="edgeSharpness" label="Edge sharpness" tooltip={TIPS.edgeSharpness} />}
        {mode === 'ramp' && <ParamSlider param="dither" label="Dither" tooltip={TIPS.dither} />}
        {(mode === 'braille' || mode === 'blocks') && <DitherPatternRow />}
      </div>
      <ParamSwitch param="invert" label="Invert" tooltip={{ body: TIPS.invert, shortcut: 'I' }} tooltipOn="switch" />
      <InvertHint />
    </Section>
  );
}

/** A mostly light (or, on light paper, mostly dark) still turns into a wall of dense glyphs. */
function InvertHint() {
  const hint = useInvertHint();
  if (!hint) return null;
  return (
    <p className="hint">
      This image is mostly {hint}.{' '}
      <button type="button" className="lnk" onClick={() => store().setParam('invert', true)}>
        Invert
      </button>{' '}
      to draw its {hint === 'light' ? 'dark' : 'light'} parts.
    </p>
  );
}

function DitherPatternRow() {
  const pattern = useStore((s) => s.params.ditherPattern);
  return (
    <LabelledRow label="Dither" tooltip={TIPS.ditherPattern}>
      {(id) => (
        <Segmented
          full
          labelledBy={id}
          value={pattern}
          onChange={(v) => store().setParam('ditherPattern', v)}
          options={PATTERNS.map((p) => ({ value: p, label: DITHER_LABELS[p] }))}
        />
      )}
    </LabelledRow>
  );
}
