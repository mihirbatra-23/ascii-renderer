/**
 * Color: Mono / Source / Duotone (D cycles) and the swatches that mode draws with. Duotone uses
 * shadow, ink and paper; Mono ink and paper. Source takes the glyph colours from the image, so
 * only the paper remains, and Blocks in Source paints both colours per cell, so nothing does
 * (ALGORITHM §7). GIF / video collapse the section to a summary row.
 */
import type { ColorMode, RenderMode } from '../../engine/types';
import { COLOR_MODES } from '../../state/params';
import { useStore } from '../../state/store';
import { Disclosure, Section, Segmented, SwatchField, cx } from '../kit';
import { commitLive, setLive, store, useRememberedOpen } from './controls';
import { COLOR_LABELS } from './copy';

type SwatchKey = 'shadowInk' | 'ink' | 'paper';

const SWATCH_LABELS: Record<SwatchKey, string> = { shadowInk: 'Shadow', ink: 'Ink', paper: 'Paper' };
const OPTIONS = COLOR_MODES.map((m) => ({ value: m, label: COLOR_LABELS[m] }));

function swatchesFor(colorMode: ColorMode, mode: RenderMode): readonly SwatchKey[] {
  if (colorMode === 'duotone') return ['shadowInk', 'ink', 'paper'];
  if (colorMode === 'mono') return ['ink', 'paper'];
  return mode === 'blocks' ? [] : ['paper'];
}

export function ColorSection() {
  const colorMode = useStore((s) => s.params.colorMode);
  return (
    <Section
      title="Color"
      tab="color"
      aux={
        <>
          {/* The board's head: the D shortcut, then the mode it has cycled to. */}
          <kbd aria-hidden="true">D</kbd>
          {COLOR_LABELS[colorMode].toLowerCase()}
        </>
      }
    >
      <ColorBody />
    </Section>
  );
}

export function ColorDisclosure() {
  const colorMode = useStore((s) => s.params.colorMode);
  const mode = useStore((s) => s.params.mode);
  const [open, setOpen] = useRememberedOpen('color');
  const summary = (
    <>
      {swatchesFor(colorMode, mode).map((k) => (
        <SwatchDot key={k} param={k} />
      ))}
      {COLOR_LABELS[colorMode]}
    </>
  );
  return (
    <Disclosure title="Color" tab="color" summary={summary} open={open} onOpenChange={setOpen}>
      <ColorBody />
    </Disclosure>
  );
}

function SwatchDot({ param }: { param: SwatchKey }) {
  const color = useStore((s) => s.params[param]);
  return <span className="swd" style={{ background: color }} />;
}

function ColorBody() {
  const colorMode = useStore((s) => s.params.colorMode);
  const mode = useStore((s) => s.params.mode);
  const keys = swatchesFor(colorMode, mode);
  return (
    <>
      <Segmented full label="Color mode" value={colorMode} options={OPTIONS} onChange={(v) => store().setParam('colorMode', v)} />
      {keys.length > 0 && (
        <div className={cx('swatches', keys.length === 2 && 'two')}>
          {keys.map((k) => (
            <ParamSwatch key={k} param={k} />
          ))}
        </div>
      )}
      {colorMode === 'source' && (
        <p className="hint">
          {mode === 'blocks'
            ? 'Each block takes its two colours from the image.'
            : 'Each glyph takes its cell’s colour from the image.'}
        </p>
      )}
    </>
  );
}

function ParamSwatch({ param }: { param: SwatchKey }) {
  const value = useStore((s) => s.params[param]);
  return <SwatchField label={SWATCH_LABELS[param]} value={value} onChange={(v) => setLive(param, v)} onCommit={commitLive} />;
}
