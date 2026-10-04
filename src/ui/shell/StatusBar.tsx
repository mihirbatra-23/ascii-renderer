/**
 * Status bar (spec §5): dim caps keys with bright values, hairline-separated, 28 px.
 *
 *   still   ● Live · MODE · GRID · RENDER ms · FPS · GPU              | CURSOR · ZOOM · 🔒 On-device
 *   clip    ● Playing · RATE · GRID · RENDER ms/f · FPS · DECODE      | CURSOR · ZOOM · 🔒 On-device
 *   camera  ● Camera · RATE · GRID · RENDER ms/f · FPS                 | CURSOR · ZOOM · 🔒 On-device
 *   split   …                                                         | VIEW Split 50% · ZOOM · …
 *   export  ● Live · MODE · GRID · RENDER                             | EXPORT PNG 2560 × 1440 · 2× · …
 *   encode  ● Encoding (accent dot) · CODEC · FRAMES · SPEED            | OUTPUT 2560 × 1440 · 2× · …
 *   record  ● Recording (accent dot) · CONTAINER · TIME · FRAMES        | OUTPUT …
 *
 * RENDER is the GPU time of a frame (analysis and compose) averaged over recent frames when the
 * browser has GPU timers, else the CPU time to submit one; FPS is what was actually drawn in the
 * last second, so a clip that cannot keep up shows it.
 *
 * Narrow windows drop readouts by priority (p3 first, then p2; shell.css). Values come from
 * store.stats (throttled by the render loop), so this re-renders a few times a second at most.
 * Render time is not announced (too chatty).
 */
import { useState, type ReactNode } from 'react';
import { useStageLayout } from '../../app/engineHost';
import { useRuntime } from '../../app/runtime';
import { useStore } from '../../state/store';
import { Icon } from '../icons';
import { cx, MODE_LABELS } from '../kit';
import { FORMAT_LABEL, VIDEO_CODEC } from '../export/sizing';
import { exportPreview } from '../stage/exportSize';
import { dims, formatFps, formatMs, formatScale } from '../stage/format';
import { formatZoom } from '../stage/viewActions';
import { formatTimecode } from '../transport/clip';

export default function StatusBar() {
  const encoding = useStore((s) => s.job.status === 'running');
  const recording = useStore((s) => s.job.status === 'running' && !!s.job.recording);
  return (
    <footer className="status" aria-label="Status">
      {recording ? <RecordItems /> : encoding ? <EncodeItems /> : <LiveItems />}
      <span className="sp" />
      <RightItems />
      <Item end>
        <Icon name="lock" size={12} />
        <span className="v">On-device</span>
      </Item>
    </footer>
  );
}

/** Which readouts narrow windows drop first: 3, then 2 (shell.css); 'opt' ones go at ≤ 1280 px. */
type Priority = 'opt' | 'p2' | 'p3';

function Item({ children, end, priority, title }: { children: ReactNode; end?: boolean; priority?: Priority; title?: string }) {
  return (
    <span className={cx('it', end && 'end', priority)} title={title}>
      {children}
    </span>
  );
}

function KV({ k, children, title, priority, end }: { k: string; children: ReactNode; title?: string; priority?: Priority; end?: boolean }) {
  return (
    <Item title={title} priority={priority} end={end}>
      <span className="k">{k}</span>
      <span className="v">{children}</span>
    </Item>
  );
}

function State({ word, on }: { word: string; on?: boolean }) {
  return (
    <Item>
      <span className={cx('dot', on && 'on')} />
      <span className="v hi">{word}</span>
    </Item>
  );
}

function LiveItems() {
  const kind = useStore((s) => s.media.info?.kind);
  const live = useStore((s) => s.media.info?.live === true);
  const loading = useStore((s) => s.media.status === 'loading');
  const playing = useStore((s) => s.playback.playing);
  const exporting = useStore((s) => s.exportUi.open);
  const clip = kind === 'animation' || kind === 'video';
  const word = loading ? 'Loading' : clip ? (playing ? (live ? 'Camera' : 'Playing') : 'Paused') : 'Live';
  return (
    <>
      <State word={word} />
      {clip && !exporting ? <RateItem live={live} /> : <ModeItem />}
      <GridItem />
      <RenderItem perFrame={clip} />
      {!exporting && <FpsItem />}
      {!exporting && clip && !live && <DecodeItem />}
      {!exporting && !clip && <GpuItem />}
    </>
  );
}

function ModeItem() {
  const mode = useStore((s) => s.params.mode);
  return (
    <KV k="Mode" priority="p2">
      {MODE_LABELS[mode]}
    </KV>
  );
}

function RateItem({ live }: { live: boolean }) {
  const fps = useStore((s) => s.media.info?.fps);
  const rate = useStore((s) => (live ? 1 : s.playback.rate));
  return (
    <KV k="Rate" priority="p2" title={live ? 'The camera’s frame rate' : rate !== 1 ? `Playing at ${rate}×` : 'The source’s frame rate'}>
      {fps ? formatFps(fps * rate) : '–'}
    </KV>
  );
}

function GridItem() {
  const cols = useStore((s) => s.stats.cols);
  const rows = useStore((s) => s.stats.rows);
  return <KV k="Grid">{cols ? dims(cols, rows) : '–'}</KV>;
}

const RENDER_TITLE = {
  gpu: 'GPU time per frame (analysis and compose), averaged over recent frames',
  cpu: 'Time to render a frame on the main thread, averaged over recent frames (this browser has no GPU timer)',
} as const;

function RenderItem({ perFrame }: { perFrame: boolean }) {
  const cols = useStore((s) => s.stats.cols);
  const ms = useStore((s) => s.stats.ms);
  const timer = useStore((s) => s.stats.timer);
  return (
    <KV k="Render" title={RENDER_TITLE[timer]}>
      {cols ? `${formatMs(ms)} ${perFrame ? 'ms/f' : 'ms'}` : '–'}
    </KV>
  );
}

function FpsItem() {
  const fps = useStore((s) => s.stats.fps);
  return (
    <KV k="FPS" priority="p3" title={fps ? 'Frames drawn in the last second' : 'Idle: the preview redraws only when something changes'}>
      {fps || '–'}
    </KV>
  );
}

function GpuItem() {
  const gpu = useStore((s) => s.stats.gpu);
  return (
    <KV k="GPU" priority="opt">
      {gpu}
    </KV>
  );
}

function DecodeItem() {
  const media = useRuntime((r) => r.media);
  if (!media || media.kind === 'image') return null;
  const decode = media.kind === 'animation' ? media.formatLabel : media.canDecodeFrames === false ? 'Video element' : 'WebCodecs';
  return (
    <KV k="Decode" priority="opt">
      {decode}
    </KV>
  );
}

/** "Encoding · CODEC MP4 · H.264 · FRAMES 41 / 66 · SPEED 2.6× realtime" (spec §4.5). */
function EncodeItems() {
  const format = useStore((s) => s.exportUi.format);
  const label = useStore((s) => s.job.label);
  const frames = /(\d+)\s*\/\s*(\d+)/.exec(label);
  const codec = VIDEO_CODEC[format];
  return (
    <>
      <State word="Encoding" on />
      <KV k="Codec">{codec ? `${FORMAT_LABEL[format]} · ${codec}` : FORMAT_LABEL[format]}</KV>
      {frames && <KV k="Frames">{`${frames[1]} / ${frames[2]}`}</KV>}
      <SpeedItem done={frames ? Number(frames[1]) : 0} />
    </>
  );
}

/** "Recording · CONTAINER MP4 · TIME 00:12.40 · FRAMES 372": a camera recorded in real time. */
function RecordItems() {
  const rec = useStore((s) => s.job.recording);
  if (!rec) return null;
  return (
    <>
      <State word="Recording" on />
      <KV k="Container">{rec.container === 'mp4' ? 'MP4' : 'WebM'}</KV>
      <KV k="Time">{formatTimecode(rec.elapsedSec)}</KV>
      <KV k="Frames" priority="p3">
        {rec.frames}
      </KV>
    </>
  );
}

/** Media seconds encoded per wall second since this encode started; "–" until there is a measurable stretch. */
function SpeedItem({ done }: { done: number }) {
  const [startedAt] = useState(() => performance.now());
  const outFps = useStore((s) => (s.exportUi.fps === 'source' ? s.media.info?.fps : s.exportUi.fps));
  const elapsed = (performance.now() - startedAt) / 1000;
  const speed = outFps && done > 0 && elapsed > 0.5 ? done / outFps / elapsed : null;
  return (
    <KV k="Speed" title="Encoded media time per second of encoding">
      {speed === null ? '–' : `${speed.toFixed(1)}× realtime`}
    </KV>
  );
}

function RightItems() {
  const exporting = useStore((s) => s.exportUi.open);
  const encoding = useStore((s) => s.job.status === 'running');
  const split = useStore((s) => (s.view.mode === 'split' ? s.view.split : null));
  if (exporting || encoding) return <ExportItem k={encoding ? 'Output' : 'Export'} />;
  return (
    <>
      {split !== null ? <KV k="View" end>{`Split ${Math.round(split * 100)}%`}</KV> : <CursorItem />}
      <ZoomItem />
    </>
  );
}

function CursorItem() {
  const probe = useStore((s) => s.view.probe);
  return (
    <KV k="Cursor" end priority="p3" title={probe ? undefined : 'Point at the preview to probe a cell'}>
      {probe ? `C${String(probe.col).padStart(3, '0')} R${String(probe.row).padStart(2, '0')}` : '–'}
    </KV>
  );
}

function ZoomItem() {
  const layout = useStageLayout();
  return (
    <KV k="Zoom" end>
      {layout ? formatZoom(layout.zoom) : '–'}
    </KV>
  );
}

function ExportItem({ k }: { k: string }) {
  const layout = useStageLayout();
  const exportUi = useStore((s) => s.exportUi);
  if (!layout) return null;
  const out = exportPreview(layout, exportUi);
  const size = out.unit === 'px' ? `${dims(out.width, out.height)} · ${formatScale(out.scale)}` : `${dims(out.width, out.height)} chars`;
  return (
    <KV k={k} end>
      {k === 'Export' ? `${exportUi.format.toUpperCase()} ${size}` : size}
    </KV>
  );
}
