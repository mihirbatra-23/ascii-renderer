/**
 * Glyphs: the glyph set (Custom opens an inline field) and the glyphs in use sorted by measured
 * density. Braille, Blocks and Halftone draw their own marks, so for them the section says that
 * instead. Images show the full section; GIF / video collapse it to a summary row.
 */
import { useRef, type RefObject } from 'react';
import { CHARSET_PRESETS, MAX_GLYPHS, resolveCharset } from '../../engine/charsets';
import { FONTS } from '../../engine/fonts';
import type { CharsetPreset } from '../../engine/types';
import { useStore } from '../../state/store';
import { MODE_LABELS, Disclosure, Section, Select, TextField, TipLabel, useTip } from '../kit';
import { commitLive, store, useRememberedOpen } from './controls';
import { CHARSETS, PROCEDURAL, TIPS } from './copy';
import { useGlyphsByDensity } from './glyphInfo';

const PRESETS: readonly CharsetPreset[] = ['ascii', 'minimal', 'dense', 'lines', 'custom'];

const OPTIONS = PRESETS.map((p) => ({
  value: p,
  label: CHARSETS[p].label,
  aux: p === 'custom' ? undefined : String(resolveCharset({ charsetPreset: p, customCharset: '' }).length),
  separatorBefore: p === 'custom',
}));

/** Collapsed row: the set name, or that drawn modes do not use one ("Not used in Braille"). */
function useGlyphSummary(): string {
  const mode = useStore((s) => s.params.mode);
  const preset = useStore((s) => s.params.charsetPreset);
  return PROCEDURAL[mode] ? `Not used in ${MODE_LABELS[mode]}` : CHARSETS[preset].label;
}

export function GlyphsSection() {
  return (
    <Section title="Glyphs" tab="glyphs">
      <GlyphsBody />
    </Section>
  );
}

export function GlyphsDisclosure() {
  const line = useGlyphSummary();
  const [open, setOpen] = useRememberedOpen('glyphs');
  return (
    <Disclosure title="Glyphs" tab="glyphs" summary={line} open={open} onOpenChange={setOpen}>
      <GlyphsBody />
    </Disclosure>
  );
}

function GlyphsBody() {
  const mode = useStore((s) => s.params.mode);
  const proc = PROCEDURAL[mode];
  if (proc) {
    return (
      <p className="hint flush">
        {proc.note} Glyph sets apply to <b>Shape</b> and <b>Ramp</b> only.
      </p>
    );
  }
  return <CharsetControls />;
}

function CharsetControls() {
  const preset = useStore((s) => s.params.charsetPreset);
  const fieldRef = useRef<HTMLInputElement>(null);

  const choose = (next: CharsetPreset) => {
    const { params, setParam, setParams } = store();
    if (next !== 'custom') return setParam('charsetPreset', next);
    // Start from the set in use, so Custom is an edit rather than a blank field.
    const seed = params.customCharset || CHARSET_PRESETS[params.charsetPreset === 'custom' ? 'ascii' : params.charsetPreset];
    setParams({ charsetPreset: 'custom', customCharset: seed.replaceAll(' ', '') });
    // After the listbox has handed focus back to its trigger.
    requestAnimationFrame(() => fieldRef.current?.focus());
  };

  return (
    <>
      <Select label="Glyph set" value={preset} options={OPTIONS} onChange={choose} />
      {preset === 'custom' && <CustomCharsetField inputRef={fieldRef} />}
      <DensityPreview />
    </>
  );
}

function CustomCharsetField({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const value = useStore((s) => s.params.customCharset);
  const unique = new Set(value.replaceAll(' ', '')).size;
  return (
    <>
      <TextField
        ref={inputRef}
        fieldClassName="cfield"
        value={value}
        placeholder="Type or paste glyphs"
        aria-label="Custom glyphs"
        onChange={(e) => store().setParam('customCharset', e.currentTarget.value, { commit: 'idle' })}
        onBlur={commitLive}
      />
      {unique === 0 && <p className="hint">Type at least one glyph. Full ASCII is used until then.</p>}
      {unique >= MAX_GLYPHS && <p className="hint">Only the first {MAX_GLYPHS - 1} glyphs are used.</p>}
    </>
  );
}

function DensityPreview() {
  const text = useGlyphsByDensity();
  const font = useStore((s) => s.params.font);
  const tip = useTip({ body: TIPS.density }, { tap: true, align: 'start', describe: false });
  return (
    <div className="glyphs" aria-hidden="true">
      <span className="str" style={{ fontFamily: `${FONTS[font].family}, var(--mono)` }}>
        {text}
      </span>
      <em>
        <TipLabel tip={tip}>by density</TipLabel>
      </em>
      {tip.node}
    </div>
  );
}
