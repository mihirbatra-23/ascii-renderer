/**
 * The 48 px transport row (spec §4.3): prev / play / next, timecode, frame counter, In / Out /
 * Dur, Loop and speed. Each readout is its own component subscribed to just its fields, so a
 * playing clip re-renders the timecode and counter, never the row.
 *
 * The row follows the stage's width (container queries in transport.css): on a narrow stage the
 * frame counter and the duration give way, and speed becomes a compact menu.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from '../../state/store';
import { Icon } from '../icons';
import { Button, IconButton, MenuButton, Segmented, Tooltip, type SegmentedOption } from '../kit';
import { dims, formatFps } from '../stage/format';
import { formatTimecode, padFrame, parseTimecode } from './clip';
import { currentClip, setInPoint, setLoop, setOutPoint, setRate, step, togglePlay } from './playback';

export default function TransportRow() {
  return (
    <div className="tp-row">
      <IconButton icon="prev" label="Previous frame" shortcut="←" onClick={() => step(-1)} />
      <PlayButton />
      <IconButton icon="next" label="Next frame" shortcut="→" onClick={() => step(1)} />
      <Timecode />
      <span className="vr desk-only" />
      <FrameCounter />
      <span className="sp" />
      <TrimFields />
      <LoopButton />
      <SpeedSegment />
      <SpeedMenu />
    </div>
  );
}

/** A camera: pause freezes the current frame (to study or export it), play resumes the stream. */
export function LiveRow() {
  const info = useStore((s) => s.media.info);
  return (
    <div className="tp-row">
      <PlayButton live />
      <div className="kv live-kv">
        <span className="k">Camera</span>
        {info ? `${dims(info.width, info.height)}${info.fps ? ` · ${formatFps(info.fps)}` : ''}` : '–'}
      </div>
    </div>
  );
}

function PlayButton({ live }: { live?: boolean }) {
  const playing = useStore((s) => s.playback.playing);
  const label = playing ? (live ? 'Pause (freeze the frame)' : 'Pause') : live ? 'Resume the camera' : 'Play';
  return (
    <Tooltip label={label} shortcut="Space">
      <button type="button" className="play" aria-label={label} onClick={togglePlay}>
        <Icon name={playing ? 'pause' : 'play'} />
      </button>
    </Tooltip>
  );
}

function Timecode() {
  const time = useStore((s) => s.playback.time);
  const duration = useStore((s) => s.playback.duration);
  return (
    <div className="tc">
      <span>{formatTimecode(time)}</span>
      <small>/ {formatTimecode(duration)}</small>
    </div>
  );
}

function FrameCounter() {
  const frame = useStore((s) => s.playback.frame);
  const count = useStore((s) => s.playback.frameCount);
  return (
    <div className="kv">
      <span className="k">Frame</span>
      {padFrame(frame + 1, count)}
      <span className="of">/ {padFrame(count, count)}</span>
    </div>
  );
}

function TrimFields() {
  const inPoint = useStore((s) => s.playback.inPoint);
  const outPoint = useStore((s) => s.playback.outPoint);
  // Nudging by a frame: In moves between frame starts, Out between frame ends.
  const nudge = (edge: 'in' | 'out', n: number) => {
    const clip = currentClip();
    if (!clip) return;
    if (edge === 'in') setInPoint(clip.frameStart(clip.frameAt(inPoint) + n));
    else setOutPoint(clip.frameStart(clip.frameAt(outPoint - 1e-6) + 1 + n));
  };
  return (
    <>
      <TimeField label="In" value={inPoint} onCommit={setInPoint} onNudge={(n) => nudge('in', n)} />
      <TimeField label="Out" value={outPoint} onCommit={setOutPoint} onNudge={(n) => nudge('out', n)} />
      <div className="kv opt desk-only dur">
        <span className="k">Dur</span>
        {(outPoint - inPoint).toFixed(2)} s
      </div>
    </>
  );
}

interface TimeFieldProps {
  label: string;
  value: number;
  onCommit(sec: number): void;
  /** ↑ ↓: ±1 frame (Shift: 10). */
  onNudge(frames: number): void;
}

/** Boxed mono timecode: type a time and press Enter (or leave the field); Esc reverts. */
function TimeField({ label, value, onCommit, onNudge }: TimeFieldProps) {
  // null while not editing: the field then follows the player.
  const [draft, setDraft] = useState<string | null>(null);
  // Escape blurs synchronously, before React applies setDraft(null); the blur must not commit.
  const reverting = useRef(false);
  const commit = () => {
    const t = draft === null || reverting.current ? null : parseTimecode(draft);
    reverting.current = false;
    setDraft(null);
    if (t !== null) onCommit(t);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commit();
      e.currentTarget.select();
    } else if (e.key === 'Escape') {
      reverting.current = true;
      e.currentTarget.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      setDraft(null);
      onNudge((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
    } else return;
    e.preventDefault();
  };
  return (
    <label className="tfield opt desk-only">
      <span className="k">{label}</span>
      <input
        value={draft ?? formatTimecode(value)}
        aria-label={`${label} point`}
        inputMode="decimal"
        spellCheck={false}
        autoComplete="off"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
      />
    </label>
  );
}

function LoopButton() {
  const loop = useStore((s) => s.playback.loop);
  return (
    <Button icon="loop" kbd="L" aria-pressed={loop} aria-label="Loop" onClick={() => setLoop(!loop)}>
      <span className="lbl-opt">Loop</span>
    </Button>
  );
}

const SPEEDS: readonly SegmentedOption<number>[] = [
  { value: 0.5, label: '0.5×' },
  { value: 1, label: '1×' },
  { value: 2, label: '2×' },
];

function SpeedSegment() {
  const rate = useStore((s) => s.playback.rate);
  return <Segmented className="desk-only speed-seg" variant="mono" label="Playback speed" options={SPEEDS} value={rate} onChange={setRate} />;
}

/** The same choice on a narrow stage, where the segment does not fit. */
function SpeedMenu() {
  const rate = useStore((s) => s.playback.rate);
  return (
    <MenuButton
      // The name starts with what the button shows ("1×"), then says what it is (label in name).
      label={
        <>
          {rate}×<span className="sr">(playback speed)</span>
        </>
      }
      className="desk-only speed-menu"
      width={140}
      items={SPEEDS.map((o) => ({ id: String(o.value), label: `${o.value}×`, checked: o.value === rate, onSelect: () => setRate(o.value) }))}
    />
  );
}
