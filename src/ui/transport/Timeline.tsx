/**
 * Timeline (spec §4.3): an 18 px seconds ruler over a 40 px filmstrip with the trim range and
 * the playhead. Click or drag the timeline to scrub (Shift snaps to whole seconds), drag the
 * brackets to trim. The scrub area and both brackets are sliders: ← → move one frame (Shift: 10).
 * The brackets sit beside the scrub slider, not inside it, because a slider's content is
 * presentational to assistive tech.
 */
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import type { LoadedAnimation, LoadedVideo } from '../../media';
import { useStore } from '../../state/store';
import { cx } from '../kit';
import { clipOf, formatTimecode, padFrame, type Clip } from './clip';
import { drawFilmstrip, sampleThumbs } from './filmstrip';
import { isPlaying, pause, play, seek, setInPoint, setOutPoint, step, useBoundClip } from './playback';

type Media = LoadedAnimation | LoadedVideo;
type Edge = 'in' | 'out';

const STRIP_H = 40;

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export default function Timeline({ media }: { media: Media }) {
  // The bound clip follows the player's real frame timestamps once they are known.
  const initial = useMemo(() => clipOf(media), [media]);
  const clip = useBoundClip() ?? initial;
  const [stripRef, width] = useWidth<HTMLDivElement>();
  const { dragging, handlers } = useTimelinePointer(stripRef, clip);
  return (
    // The ruler and the playhead flag scrub too, so the whole timeline takes the pointer.
    <div className="tl" {...handlers}>
      <SecondsRuler duration={clip.duration} width={width} />
      <Strip stripRef={stripRef} media={media} clip={clip} width={width} dragging={dragging} />
    </div>
  );
}

// ---------------------------------------------------------------- seconds ruler

const LABEL_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
/** Minor ticks per labelled step (1 s splits in sixths, as drawn on the boards). */
const SUBDIVISIONS: Record<number, number> = { 1: 6, 2: 4, 5: 5, 10: 5, 15: 3, 30: 6, 60: 6, 120: 4, 300: 5, 600: 6 };
/** Labels sit at least this far apart, so numerals never shrink below 10 px. */
const MIN_LABEL_GAP = 36;

function secondsLabel(t: number): string {
  return t < 60 ? `${t}s` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

const SecondsRuler = memo(function SecondsRuler({ duration, width }: { duration: number; width: number }) {
  if (duration <= 0 || width <= 0) return <div className="tl-r" aria-hidden="true" />;
  const pps = width / duration;
  const labelStep = LABEL_STEPS.find((s) => s * pps >= MIN_LABEL_GAP) ?? LABEL_STEPS.at(-1)!;
  const sub = SUBDIVISIONS[labelStep];
  const minor = (labelStep * pps) / sub >= 5 ? labelStep / sub : 0;

  const majors: number[] = [];
  const minors: number[] = [];
  for (let t = 0; t <= duration + 1e-9; t += labelStep) majors.push(t);
  if (minor) {
    for (let i = 1; i * minor <= duration + 1e-9; i++) if (i % sub) minors.push(i * minor);
  }
  const x = (t: number) => Math.min(width - 1, Math.round(t * pps));
  // A label needs room for its text before the end of the strip.
  const labels = majors.filter((t) => t * pps <= width - 24);

  return (
    <div className="tl-r" aria-hidden="true">
      <svg>
        {minors.map((t) => (
          <rect key={`m${t}`} className="mn" x={x(t)} y={3} width={1} height={3} />
        ))}
        {majors.map((t) => (
          <rect key={`M${t}`} className="mj" x={x(t)} y={0} width={1} height={6} />
        ))}
      </svg>
      {labels.map((t) => (
        <span key={t} style={{ left: `${(t / duration) * 100}%` }}>
          {secondsLabel(t)}
        </span>
      ))}
    </div>
  );
});

// ---------------------------------------------------------------- strip

interface Drag {
  kind: 'scrub' | Edge;
  wasPlaying: boolean;
  /** Pointer time minus the bracket's time when grabbed, so a bracket never jumps to the pointer. */
  offset: number;
}

/**
 * Click or drag anywhere on the timeline to scrub (paused meanwhile, Shift snaps to whole
 * seconds); a bracket drags its trim point. Trims apply at most once per frame, because moving
 * the in point can seek the player.
 */
function useTimelinePointer(stripRef: RefObject<HTMLDivElement | null>, clip: Clip) {
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<Edge | null>(null);
  const trimFrame = useRef(0);
  const trimNext = useRef<{ edge: Edge; t: number } | null>(null);
  const { duration } = clip;

  useEffect(() => () => cancelAnimationFrame(trimFrame.current), []);

  const timeAt = (clientX: number, snapSeconds: boolean) => {
    const rect = stripRef.current!.getBoundingClientRect();
    const t = (Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) || 0) * duration;
    return snapSeconds ? Math.min(duration, Math.round(t)) : t;
  };

  const scheduleTrim = (edge: Edge, t: number) => {
    trimNext.current = { edge, t };
    if (trimFrame.current) return;
    trimFrame.current = requestAnimationFrame(() => {
      trimFrame.current = 0;
      const next = trimNext.current;
      if (next) trimTo(clip, next.edge, next.t);
    });
  };

  const endDrag = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(null);
    if (d.kind === 'scrub' && d.wasPlaying) play();
  };

  const handlers = {
    onPointerDown(e: PointerEvent<HTMLDivElement>) {
      if (e.button !== 0 || duration <= 0 || !stripRef.current) return;
      const edge = (e.target as HTMLElement).closest<HTMLElement>('[data-edge]')?.dataset.edge as Edge | undefined;
      e.currentTarget.setPointerCapture(e.pointerId);
      if (edge) {
        const { inPoint, outPoint } = useStore.getState().playback;
        drag.current = { kind: edge, wasPlaying: false, offset: timeAt(e.clientX, false) - (edge === 'in' ? inPoint : outPoint) };
        setDragging(edge);
      } else {
        drag.current = { kind: 'scrub', wasPlaying: isPlaying(), offset: 0 };
        pause();
        seek(timeAt(e.clientX, e.shiftKey));
      }
    },
    onPointerMove(e: PointerEvent<HTMLDivElement>) {
      const d = drag.current;
      if (!d) return;
      if (d.kind === 'scrub') seek(timeAt(e.clientX, e.shiftKey));
      else scheduleTrim(d.kind, timeAt(e.clientX, false) - d.offset);
    },
    onPointerUp: endDrag,
    onLostPointerCapture: endDrag,
  };
  return { dragging, handlers };
}

const pct = (t: number, duration: number) => (duration > 0 ? (t / duration) * 100 : 0);

interface StripProps {
  stripRef: RefObject<HTMLDivElement | null>;
  media: Media;
  clip: Clip;
  width: number;
  dragging: Edge | null;
}

function Strip({ stripRef, media, clip, width, dragging }: StripProps) {
  const inPoint = useStore((s) => s.playback.inPoint);
  const outPoint = useStore((s) => s.playback.outPoint);
  const scrubRef = useRef<HTMLDivElement>(null);
  const { duration } = clip;

  // aria-valuenow / valuetext change every frame: written directly so the strip never re-renders for them.
  useEffect(() => {
    const write = ({ frame, time, frameCount }: { frame: number; time: number; frameCount: number }) => {
      const el = scrubRef.current;
      if (!el) return;
      el.setAttribute('aria-valuemax', String(frameCount));
      el.setAttribute('aria-valuenow', String(frame + 1));
      el.setAttribute('aria-valuetext', `Frame ${frame + 1}, ${time.toFixed(2)} seconds`);
    };
    write(useStore.getState().playback);
    return useStore.subscribe((s) => s.playback, write);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.altKey || e.metaKey || e.ctrlKey) return;
    const n = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') step(-n);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') step(n);
    else if (e.key === 'Home') seek(inPoint);
    else if (e.key === 'End') seek(outPoint);
    else return;
    e.preventDefault();
  };

  const inPct = pct(inPoint, duration);
  const outPct = pct(outPoint, duration);
  return (
    <div ref={stripRef} className="strip">
      <div ref={scrubRef} className="scrub" role="slider" tabIndex={0} aria-label="Timeline" aria-valuemin={1} onKeyDown={onKeyDown}>
        <Filmstrip media={media} clip={clip} width={width} />
      </div>
      <span className="out" style={{ left: 0, width: `${inPct}%` }} />
      <span className="out" style={{ left: `${outPct}%`, right: 0 }} />
      <span className="rng" style={{ left: `${inPct}%`, right: `${100 - outPct}%` }}>
        <TrimHandle edge="in" clip={clip} value={inPoint} other={outPoint} dragging={dragging === 'in'} />
        <TrimHandle edge="out" clip={clip} value={outPoint} other={inPoint} dragging={dragging === 'out'} />
      </span>
      <Playhead duration={duration} />
    </div>
  );
}

/** In points snap to frame starts, out points to frame ends. */
function trimTo(clip: Clip, edge: Edge, t: number): void {
  if (edge === 'in') setInPoint(clip.frameStart(clip.frameAt(t)));
  else setOutPoint(clip.frameStart(clip.frameAt(t) + 1));
}

function TrimHandle({ edge, clip, value, other, dragging }: { edge: Edge; clip: Clip; value: number; other: number; dragging: boolean }) {
  const name = edge === 'in' ? 'In point' : 'Out point';
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const n = e.shiftKey ? 10 : 1;
    // The frame the bracket sits on: the first frame inside for In, the last one for Out.
    const frame = edge === 'in' ? clip.frameAt(value) : clip.frameAt(value - 1e-6);
    let target: number;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') target = frame - n;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') target = frame + n;
    else if (e.key === 'Home') target = edge === 'in' ? 0 : clip.frameAt(other);
    else if (e.key === 'End') target = edge === 'in' ? clip.frameAt(other - 1e-6) : clip.frameCount - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    if (edge === 'in') setInPoint(clip.frameStart(target));
    else setOutPoint(clip.frameStart(target + 1));
  };
  return (
    <span
      className={cx('hd', edge === 'in' ? 'in' : 'out2', dragging && 'is-drag')}
      data-edge={edge}
      role="slider"
      tabIndex={0}
      aria-label={name}
      aria-valuemin={0}
      aria-valuemax={Number(clip.duration.toFixed(2))}
      aria-valuenow={Number(value.toFixed(2))}
      aria-valuetext={`${name} ${formatTimecode(value)}`}
      onKeyDown={onKeyDown}
    >
      {dragging && <span className="hd-tip">{formatTimecode(value)}</span>}
    </span>
  );
}

function Playhead({ duration }: { duration: number }) {
  const time = useStore((s) => s.playback.time);
  const frame = useStore((s) => s.playback.frame);
  const frameCount = useStore((s) => s.playback.frameCount);
  return (
    <span className="ph" style={{ left: `${pct(time, duration)}%` }} aria-hidden="true">
      <b>{padFrame(frame + 1, frameCount)}</b>
    </span>
  );
}

/**
 * Halftone thumbnails, one slot per strip height × source aspect. Redrawn only when the slot
 * count, media or theme (the paper colour is a CSS token) changes; the previous drawing stays,
 * stretched, until the new snapshots are ready.
 */
const Filmstrip = memo(function Filmstrip({ media, clip, width }: { media: Media; clip: Clip; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const theme = useStore((s) => s.ui.theme);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || width <= 0) return;
    const count = Math.max(1, Math.round(width / (STRIP_H * (media.width / media.height))));
    let live = true;
    // Debounced: a window resize changes the count many times in a row.
    const timer = setTimeout(() => {
      sampleThumbs(media, count)
        .then((frames) => {
          if (!live) return;
          // Short animations return every frame (fewer than the slots): pick the frame at each slot's time.
          const slots =
            frames.length === count
              ? frames
              : Array.from({ length: count }, (_, k) => frames[clip.frameAt(((k + 0.5) / count) * clip.duration)] ?? null);
          const dpr = window.devicePixelRatio || 1;
          canvas.width = Math.round(width * dpr);
          canvas.height = Math.round(STRIP_H * dpr);
          const paper = getComputedStyle(canvas).getPropertyValue('--paper').trim() || '#0b0b0c';
          drawFilmstrip(canvas, slots, paper, dpr);
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [media, clip, width, theme]);
  return <canvas ref={ref} aria-hidden="true" />;
});
