/**
 * Format tiles (spec §4.4 / §5 `.fmt`): Still (PNG, SVG, TXT, HTML) and Motion (GIF, MP4, WebM).
 * One choice across both rows; each row is a radiogroup with its own tab stop. Motion formats
 * are disabled for still sources, with the reason underneath. For a clip, the still formats
 * save the frame at the playhead, and their sublabels say so. A live camera records MP4 / WebM
 * (sublabel "Record"); it has no GIF.
 */
import { useEffect } from 'react';
import { runtime, useRuntime } from '../../app/runtime';
import type { ExportFormat } from '../../export/types';
import type { LoadedMedia } from '../../media';
import { selectIsAnimated, selectIsLive, useStore } from '../../state/store';
import { Section, onRovingKeyDown, rovingTabIndex } from '../kit';
import { FORMAT_LABEL, isMotion } from './sizing';

interface FormatInfo {
  value: ExportFormat;
  sub: string;
  /** Sublabel when the source is a GIF or video. */
  clipSub?: string;
  disabled?: boolean;
}

const STILL: readonly FormatInfo[] = [
  { value: 'png', sub: 'Raster', clipSub: 'Frame' },
  { value: 'svg', sub: 'Vector', clipSub: 'Frame' },
  { value: 'txt', sub: 'Text', clipSub: 'Frame' },
  { value: 'html', sub: 'Web page', clipSub: 'Frame' },
];

const MOTION: readonly FormatInfo[] = [
  { value: 'gif', sub: 'Animated' },
  { value: 'mp4', sub: 'H.264' },
  { value: 'webm', sub: 'VP9' },
];

/** A camera's motion formats are recorded in real time; a GIF needs a finished clip. */
const LIVE_MOTION: readonly FormatInfo[] = [
  { value: 'gif', sub: 'Animated', disabled: true },
  { value: 'mp4', sub: 'Record' },
  { value: 'webm', sub: 'Record' },
];

/** The media the user last picked a format for: their choice then outranks the defaults below. */
let chosenFor: LoadedMedia | undefined;

/**
 * A clip opens Export on its own kind (GIF for animations, MP4 for video) until the user picks a
 * format; a still never keeps a motion format.
 */
export function useFormatDefault(): void {
  const media = useRuntime((r) => r.media);
  useEffect(() => {
    const { exportUi, setExportUi } = useStore.getState();
    if (!media) return;
    if (media.kind === 'image') {
      if (isMotion(exportUi.format)) setExportUi({ format: 'png' });
    } else if (media.kind === 'video' && media.live) {
      if (exportUi.format === 'gif' || (chosenFor !== media && !isMotion(exportUi.format))) setExportUi({ format: 'mp4' });
    } else if (chosenFor !== media && !isMotion(exportUi.format)) {
      setExportUi({ format: media.kind === 'animation' ? 'gif' : 'mp4' });
    }
  }, [media]);
}

export default function FormatSection() {
  const format = useStore((s) => s.exportUi.format);
  const animated = useStore(selectIsAnimated);
  const live = useStore(selectIsLive);
  const setExportUi = useStore((s) => s.setExportUi);
  const choose = (value: ExportFormat) => {
    chosenFor = runtime.get().media;
    setExportUi({ format: value });
  };
  return (
    <Section title="Format">
      <p className="sublbl">Still</p>
      <FormatRow label="Still formats" items={STILL} value={format} animated={animated} onChange={choose} />
      <p className="sublbl">Motion</p>
      <FormatRow label="Motion formats" items={live ? LIVE_MOTION : MOTION} value={format} animated={animated} disabled={!animated} onChange={choose} />
      {!animated && <p className="hint">Needs a GIF or video source.</p>}
      {live && <p className="hint">A camera records MP4 or WebM until you stop it.</p>}
    </Section>
  );
}

interface FormatRowProps {
  label: string;
  items: readonly FormatInfo[];
  value: ExportFormat;
  animated: boolean;
  disabled?: boolean;
  onChange(value: ExportFormat): void;
}

function FormatRow({ label, items, value, animated, disabled, onChange }: FormatRowProps) {
  const anyChecked = items.some((f) => f.value === value);
  return (
    <div className="fmts" role="radiogroup" aria-label={label} onKeyDown={(e) => onRovingKeyDown(e)}>
      {items.map((f, i) => {
        const checked = f.value === value;
        return (
          <button
            key={f.value}
            type="button"
            className="fmt"
            role="radio"
            aria-checked={checked}
            tabIndex={rovingTabIndex(checked, i, anyChecked)}
            disabled={disabled || f.disabled}
            onClick={() => !checked && onChange(f.value)}
          >
            <b>{FORMAT_LABEL[f.value]}</b>
            <small>{(animated && f.clipSub) || f.sub}</small>
          </button>
        );
      })}
    </div>
  );
}
