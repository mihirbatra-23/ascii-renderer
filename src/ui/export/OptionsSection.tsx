/**
 * Options (spec §4.4–4.5), per format: trimmed range only, transparent background (disabled with
 * the reason where the file cannot have it), pixel-snap, SVG glyphs as outlines or live text,
 * output fps and audio for video sources, and the file name with its fixed extension.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useRuntime } from '../../app/runtime';
import { exportAudioPlan, exportFileName, gifFps, type AudioPlan } from '../../export';
import type { ExportFormat } from '../../export/types';
import type { LoadedMedia, LoadedVideo } from '../../media';
import { selectIsLive, useStore } from '../../state/store';
import { Section, Segmented, SwitchRow, TextField, cx, type SegmentedOption } from '../kit';
import { formatTimecode } from '../transport/clip';
import { exportRange, motionFrameCount, useFrameTimes } from './frameCount';
import { ALPHA_FORMATS, isMotion, isRaster, isVideo, nearestScale, SCALE_STEPS, type ExportPlan } from './sizing';

/** Why a format cannot be transparent (undefined: the option does not apply to it). */
const NO_ALPHA: Partial<Record<ExportFormat, string>> = {
  gif: 'GIF has no soft transparency, so the paper colour fills it.',
  mp4: 'MP4 has no alpha channel. Use WebM.',
};

const TRANSPARENT_SUB: Partial<Record<ExportFormat, string>> = {
  png: 'Drops the paper; glyphs keep their ink',
  svg: 'Drops the paper; glyphs keep their ink',
  webm: 'VP9 with alpha, where this browser can encode it',
};

export default function OptionsSection({ plan }: { plan: ExportPlan | null }) {
  const format = useStore((s) => s.exportUi.format);
  const media = useRuntime((r) => r.media);
  const clip = media && media.kind !== 'image' ? media : null;
  const video = clip?.kind === 'video' && !clip.live ? clip : null;
  return (
    <Section title="Options">
      {clip && !(clip.kind === 'video' && clip.live) && isMotion(format) && <TrimRow />}
      {(ALPHA_FORMATS.includes(format) || NO_ALPHA[format]) && <TransparentRow format={format} />}
      {plan && isRaster(format) && (format === 'png' || plan.targetWidth !== undefined) && <PixelSnapRow plan={plan} />}
      {format === 'svg' && <SvgTextRow />}
      {video && isMotion(format) && <FpsRow format={format} sourceFps={video.fps} />}
      {video?.hasAudio && isVideo(format) && <AudioRow video={video} format={format} />}
      <FileNameField plan={plan} />
    </Section>
  );
}

function TrimRow() {
  const media = useRuntime((r) => r.media);
  const format = useStore((s) => s.exportUi.format);
  const trimOnly = useStore((s) => s.exportUi.trimOnly);
  const fps = useStore((s) => s.exportUi.fps);
  const inPoint = useStore((s) => s.playback.inPoint);
  const outPoint = useStore((s) => s.playback.outPoint);
  const setExportUi = useStore((s) => s.setExportUi);
  const frameTimes = useFrameTimes();
  if (!media || media.kind === 'image') return null;
  const inTrim = motionFrameCount(media, format, exportRange(true, inPoint, outPoint), fps, frameTimes);
  const total = motionFrameCount(media, format, {}, fps, frameTimes);
  return (
    <SwitchRow
      label="Trimmed range only"
      sub={`${formatTimecode(inPoint)} – ${formatTimecode(outPoint)} · ${inTrim.approx ? '≈ ' : ''}${inTrim.count} of ${total.count} frames`}
      checked={trimOnly}
      onChange={(v) => setExportUi({ trimOnly: v })}
    />
  );
}

function TransparentRow({ format }: { format: ExportFormat }) {
  const transparent = useStore((s) => s.exportUi.transparent);
  const blocksInSource = useStore((s) => s.params.mode === 'blocks' && s.params.colorMode === 'source');
  const recorded = useStore((s) => selectIsLive(s) && isMotion(format));
  const setExportUi = useStore((s) => s.setExportUi);
  const reason =
    NO_ALPHA[format] ??
    (recorded ? 'Recordings keep the paper: browsers can’t reliably record transparency.' : undefined) ??
    (blocksInSource ? 'Blocks in Source colour paints both colours of every cell, so there is no paper to drop.' : undefined);
  return (
    <SwitchRow
      label="Transparent background"
      sub={reason ?? TRANSPARENT_SUB[format]}
      checked={transparent && !reason}
      disabled={!!reason}
      onChange={(v) => setExportUi({ transparent: v })}
    />
  );
}

/**
 * Whole scales keep whole-pixel cells by construction, so the switch is shown on and locked, with
 * the reason as its sub-line (spec §11: say why a control is disabled). A custom width between
 * scales is resampled: the switch is off, and turning it on snaps the width to the nearest whole scale.
 */
function PixelSnapRow({ plan }: { plan: ExportPlan }) {
  const setExportUi = useStore((s) => s.setExportUi);
  const motion = isMotion(plan.format);
  const resampled = plan.targetWidth !== undefined;
  const snap = () => {
    const near = nearestScale(plan);
    setExportUi(motion ? { motionScale: near } : { scale: near });
  };
  return (
    <SwitchRow
      className={cx(!resampled && 'locked')}
      label="Pixel-snap glyphs"
      sub={
        resampled
          ? 'Off for this width: cells are resampled. Turn on for the nearest whole scale.'
          : `Always on at ${SCALE_STEPS.map((s) => `${s}×`).join(', ').replace(/, ([^,]*)$/, ' and $1')}: whole-pixel cells. Choose Custom to resample.`
      }
      checked={!resampled}
      disabled={!resampled}
      onChange={(on) => on && snap()}
    />
  );
}

const SVG_TEXT: readonly SegmentedOption<'outlines' | 'text'>[] = [
  { value: 'outlines', label: 'Outlines' },
  { value: 'text', label: 'Live text' },
];

function SvgTextRow() {
  const svgText = useStore((s) => s.exportUi.svgText);
  const glyphMode = useStore((s) => s.params.mode === 'shape' || s.params.mode === 'ramp');
  const setExportUi = useStore((s) => s.setExportUi);
  const labelId = useId();
  return (
    <>
      <div className="segrow">
        <span id={labelId}>Glyphs as</span>
        <Segmented
          full
          labelledBy={labelId}
          options={SVG_TEXT.map((o) => ({ ...o, disabled: !glyphMode }))}
          value={svgText}
          onChange={(v) => setExportUi({ svgText: v })}
        />
      </div>
      <p className="hint">
        {glyphMode
          ? svgText === 'outlines'
            ? 'Paths: pastes cleanly into Figma and needs no font.'
            : 'Selectable text with the font embedded.'
          : 'Braille, halftone and blocks are drawn as shapes.'}
      </p>
    </>
  );
}

function FpsRow({ format, sourceFps }: { format: ExportFormat; sourceFps: number }) {
  const fps = useStore((s) => s.exportUi.fps);
  const setExportUi = useStore((s) => s.setExportUi);
  const labelId = useId();
  // GIF's "source" rate is capped at 25 fps by the encoder.
  const src = Math.round(format === 'gif' ? gifFps(sourceFps) : sourceFps);
  const options: SegmentedOption<number | 'source'>[] = [
    { value: 12, label: '12' },
    { value: 15, label: '15' },
    { value: 30, label: '30' },
    { value: 'source', label: `Src ${src}`, ariaLabel: `Source rate, ${src} fps` },
  ];
  return (
    <div className="segrow">
      <span id={labelId}>Output fps</span>
      <Segmented full variant="mono" labelledBy={labelId} options={options} value={fps} onChange={(v) => setExportUi({ fps: v })} />
    </div>
  );
}

/** What the export does with the source audio, in the switch's sub-line (the exporter's own plan). */
function useAudioPlan(video: LoadedVideo, format: 'mp4' | 'webm'): AudioPlan | null {
  const [result, setResult] = useState<{ video: LoadedVideo; format: string; plan: AudioPlan } | null>(null);
  useEffect(() => {
    let live = true;
    exportAudioPlan(video, format).then(
      (plan) => live && setResult({ video, format, plan }),
      // Unreadable track: the sub-line stays generic; the export reports what happened.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [video, format]);
  // A plan for another file or format is never shown.
  return result?.video === video && result.format === format ? result.plan : null;
}

function audioSub(plan: AudioPlan | null): string {
  if (!plan) return 'The source track, copied or converted to suit the format';
  switch (plan.action) {
    case 'copy':
      return `Copied from the source track (${plan.from})`;
    case 'transcode':
      return `Converted from ${plan.from} to ${plan.to} for this format`;
    case 'none':
      return plan.note ?? 'This file has no audio this browser can include';
  }
}

function AudioRow({ video, format }: { video: LoadedVideo; format: 'mp4' | 'webm' }) {
  const includeAudio = useStore((s) => s.exportUi.includeAudio);
  const setExportUi = useStore((s) => s.setExportUi);
  const plan = useAudioPlan(video, format);
  const none = plan?.action === 'none';
  return (
    <SwitchRow
      label="Include audio"
      sub={audioSub(plan)}
      checked={includeAudio && !none}
      disabled={none}
      onChange={(v) => setExportUi({ includeAudio: v })}
    />
  );
}

/** The media the typed file name belongs to; another file starts from its default name again. */
let namedFor: LoadedMedia | undefined;

function FileNameField({ plan }: { plan: ExportPlan | null }) {
  const format = useStore((s) => s.exportUi.format);
  const fileName = useStore((s) => s.exportUi.fileName);
  const sourceName = useStore((s) => s.media.info?.name ?? 'image');
  const setExportUi = useStore((s) => s.setExportUi);
  const media = useRuntime((r) => r.media);
  const id = useId();
  // While typing, an emptied field stays empty; the default name comes back on blur.
  const [draft, setDraft] = useState<string | null>(null);
  // The name when the field took focus: Escape returns to it.
  const atFocus = useRef(fileName);
  useEffect(() => {
    if (namedFor !== media) setExportUi({ fileName: '' });
  }, [media, setExportUi]);
  // Every format's extension is its own name.
  const fallback = plan ? exportFileName(sourceName, plan.grid, format).slice(0, -(format.length + 1)) : '';

  // Escape in a text field undoes the typing and leaves the field; only a second Escape closes Export.
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.preventDefault();
    setExportUi({ fileName: atFocus.current });
    setDraft(null);
    e.currentTarget.blur();
  };

  return (
    <>
      <label className="flabel" htmlFor={id}>
        File name
      </label>
      <TextField
        id={id}
        value={draft ?? (fileName || fallback)}
        suffix={`.${format}`}
        onFocus={() => (atFocus.current = useStore.getState().exportUi.fileName)}
        onChange={(e) => {
          namedFor = media;
          setDraft(e.currentTarget.value);
          setExportUi({ fileName: e.currentTarget.value.trim() });
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setDraft(null)}
      />
    </>
  );
}
