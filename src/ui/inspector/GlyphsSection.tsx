/**
 * Glyphs: the character set (Custom opens an inline field), the glyph count, and the set sorted
 * by measured density. Braille, Blocks and Halftone draw their own marks, so for them the section
 * says that instead. Images show the full section; GIF / video collapse it to a summary row.
 */
import { useMemo, useRef, type RefObject } from 'react';
import { CHARSET_PRESETS, MAX_GLYPHS, resolveCharset } from '../../engine/charsets';
import { FONTS } from '../../engine/fonts';
import type { CharsetPreset } from '../../engine/types';
import { useStore } from '../../state/store';
import { Disclosure, Section, Select, TextField } from '../kit';
import { commitLive, store, useRememberedOpen } from './controls';
import { CHARSETS, PROCEDURAL } from './copy';
import { useGlyphsByDensity } from './glyphInfo';

const PRESETS: readonly CharsetPreset[] = ['ascii', 'minimal', 'dense', 'lines', 'custom'];

const OPTIONS = PRESETS.map((p) => ({
  value: p,
  label: CHARSETS[p].label,
  aux: p === 'custom' ? 'type your own' : String(resolveCharset({ charsetPreset: p, customCharset: '' }).length),
  separatorBefore: p === 'custom',
}));

interface GlyphSummary {
  /** Section head, e.g. "95 glyphs" (the number is set brighter than the noun). */
  count: number | null;
  noun: string;
  /** Collapsed row, e.g. "Full ASCII · 95". */
  line: string;
}

function useGlyphSummary(): GlyphSummary {
  const mode = useStore((s) => s.params.mode);
  const preset = useStore((s) => s.params.charsetPreset);
  const custom = useStore((s) => s.params.customCharset);
  return useMemo(() => {
    const proc = PROCEDURAL[mode];
    if (proc) return { count: null, noun: proc.aux, line: proc.line };
    const count = resolveCharset({ charsetPreset: preset, customCharset: custom }).length;
    return { count, noun: 'glyphs', line: `${CHARSETS[preset].label} · ${count}` };
  }, [mode, preset, custom]);
}

export function GlyphsSection() {
  const { count, noun } = useGlyphSummary();
  return (
    <Section
      title="Glyphs"
      tab="glyphs"
      aux={
        count === null ? (
          <em>{noun}</em>
        ) : (
          <>
            {count} <em>{noun}</em>
          </>
        )
      }
    >
      <GlyphsBody />
    </Section>
  );
}

export function GlyphsDisclosure() {
  const { line } = useGlyphSummary();
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
        {proc.note} Character sets apply to <b>Shape</b> and <b>Ramp</b>.
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
      <Select label="Character set" value={preset} options={OPTIONS} aux={CHARSETS[preset].aux} onChange={choose} />
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
      {unique === 0 && <p className="hint">Type at least one glyph. Until then Full ASCII is used.</p>}
      {unique >= MAX_GLYPHS && <p className="hint">Only the first {MAX_GLYPHS - 1} glyphs are used.</p>}
    </>
  );
}

function DensityPreview() {
  const text = useGlyphsByDensity();
  const font = useStore((s) => s.params.font);
  return (
    <div className="glyphs" aria-hidden="true" title="Glyphs sorted by measured density, light to dark">
      <span className="str" style={{ fontFamily: `${FONTS[font].family}, var(--mono)` }}>
        {text}
      </span>
      <em>by density</em>
    </div>
  );
}
