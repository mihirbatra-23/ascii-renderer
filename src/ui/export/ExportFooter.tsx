/**
 * Sticky export footer (spec §4.4–4.5). At rest: a copy action for the selected format (Copy PNG,
 * Copy SVG, otherwise Copy text) and the one primary action, Download <FORMAT> ⌘↵ (Record <FORMAT>
 * for a camera's MP4 / WebM). While a GIF or video encodes: percentage, tick meter, frame / ETA /
 * encoder line, Cancel and a disabled Save until it is done; while a camera records, the same
 * layout with the elapsed time, Discard and Stop and save. A failure shows inline above the
 * actions with Try again (for the same file).
 *
 * Focus never falls to <body>: Download stays focusable while a still exports (aria-disabled, not
 * disabled), Cancel (Stop for a recording) takes focus when the busy footer replaces it, and
 * Download gets it back when the job ends or is cancelled.
 */
import { useEffect, useLayoutEffect, useRef, type Ref } from 'react';
import { useRuntime } from '../../app/runtime';
import { shortcutLabel } from '../../app/shortcuts';
import { hasWebCodecs } from '../../export';
import type { ExportFormat } from '../../export/types';
import { IDLE_JOB, selectIsLive, useStore } from '../../state/store';
import { Icon } from '../icons';
import { Button, IconButton, TickMeter } from '../kit';
import type { PanelEstimate } from './estimate';
import { activeRecording, cancelExport, copyExport, COPY_PNG_MAX_PIXELS, jobFormat, lastJobMedia, runExport, stopRecording } from './exportJob';
import { FORMAT_LABEL, isMotion, VIDEO_CODEC, type ExportPlan } from './sizing';

/** Whether focus is nowhere useful (the focused control was removed or disabled). */
const focusLost = () => !document.activeElement || document.activeElement === document.body;

export default function ExportFooter({ plan, estimate }: { plan: ExportPlan | null; estimate: PanelEstimate }) {
  // Starting and ending an encode always changes the job, which re-renders this.
  const status = useStore((s) => s.job.status);
  const recording = useStore((s) => s.job.recording !== null);
  const running = status === 'running';
  const encoding = running ? jobFormat() : null;
  const busy = recording || (encoding !== null && isMotion(encoding));
  const downloadRef = useRef<HTMLButtonElement>(null);
  const wasBusy = useRef(false);

  // The encode or recording footer is gone (done, failed or cancelled): Download takes focus back from <body>.
  useEffect(() => {
    if (wasBusy.current && !busy && focusLost()) downloadRef.current?.focus({ preventScroll: true });
    wasBusy.current = busy;
  }, [busy]);

  if (recording && encoding) return <RecordingFooter format={encoding} />;
  if (busy && encoding) return <EncodingFooter format={encoding} />;
  return (
    <>
      {status === 'error' && <ExportError />}
      <div className="df exp">
        <CopyButton plan={plan} />
        <DownloadButton ref={downloadRef} plan={plan} estimate={estimate} running={running} />
      </div>
    </>
  );
}

function CopyButton({ plan }: { plan: ExportPlan | null }) {
  const format = useStore((s) => s.exportUi.format);
  if (format === 'png') {
    const tooLarge = !!plan && plan.width * plan.height > COPY_PNG_MAX_PIXELS;
    return (
      <Button
        icon="copy"
        disabled={!plan || tooLarge}
        title={tooLarge ? 'Too large to copy at this size; download it instead' : undefined}
        onClick={() => void copyExport('png')}
      >
        Copy PNG
      </Button>
    );
  }
  const svg = format === 'svg';
  return (
    <Button icon="copy" disabled={!plan} onClick={() => void copyExport(svg ? 'svg' : 'text')}>
      {svg ? 'Copy SVG' : 'Copy text'}
    </Button>
  );
}

interface DownloadButtonProps {
  ref: Ref<HTMLButtonElement>;
  plan: ExportPlan | null;
  estimate: PanelEstimate;
  running: boolean;
}

function DownloadButton({ ref, plan, estimate, running }: DownloadButtonProps) {
  const format = useStore((s) => s.exportUi.format);
  // A camera has no file to convert: its motion formats are recorded until stopped.
  const record = useStore((s) => selectIsLive(s) && isMotion(s.exportUi.format));
  const unavailable = !plan || !estimate.supported;
  return (
    <Button
      ref={ref}
      variant="primary"
      icon={record ? 'record' : 'download'}
      kbd={shortcutLabel('export.download')}
      stretch="grow"
      disabled={unavailable}
      // Busy, not disabled: a disabled button drops keyboard focus to <body>.
      aria-disabled={running || undefined}
      aria-busy={running}
      onClick={() => !running && void runExport()}
    >
      {running ? 'Exporting…' : `${record ? 'Record' : 'Download'} ${FORMAT_LABEL[format]}`}
    </Button>
  );
}

function encoderLabel(format: ExportFormat): string {
  if (format === 'gif') return 'Worker · GIF';
  if (!hasWebCodecs()) return 'MediaRecorder';
  return `WebCodecs · ${VIDEO_CODEC[format]}`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function EncodingFooter({ format }: { format: ExportFormat }) {
  const progress = useStore((s) => s.job.progress);
  const label = useStore((s) => s.job.label);
  const eta = useStore((s) => s.job.etaSec);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const pct = progress === null ? null : Math.round(progress * 100);
  const sec = eta === null ? 0 : Math.ceil(eta);
  const left = eta === null ? '' : ` · ${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)} left`;

  // Download was focused and is gone with the rest footer: Cancel is the action now.
  useLayoutEffect(() => {
    if (focusLost()) cancelRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="df enc">
      <div className="prog">
        <div className="ln">
          <span>Encoding in a worker. Keep editing.</span>
          <span className="pc">{pct === null ? '–' : `${pct}%`}</span>
        </div>
        <TickMeter value={progress} label="Encoding progress" />
        <div className="ln">
          <span className="meta">
            {/* The line above already says it is encoding: 'Frame 41 / 66 · 00:02 left'. */}
            {label.replace(/^Encoding frame/, 'Frame')}
            {left}
          </span>
          <span className="meta">{encoderLabel(format)}</span>
        </div>
        <div className="ln acts">
          <Button ref={cancelRef} onClick={cancelExport}>
            Cancel
          </Button>
          <Button variant="primary" icon="download" stretch="grow" disabled>
            Save {FORMAT_LABEL[format]}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * While a camera records (styled like the encode state): elapsed time where the percentage would
 * be, an indeterminate meter, frames and size, Discard, and Stop and save (⌘↵) as the primary.
 */
function RecordingFooter({ format }: { format: ExportFormat }) {
  const stopRef = useRef<HTMLButtonElement>(null);
  const progress = useStore((s) => s.job.recording);
  // Record was focused and is gone with the rest footer: Stop is the action now.
  useLayoutEffect(() => {
    if (focusLost()) stopRef.current?.focus({ preventScroll: true });
  }, []);
  const live = activeRecording();
  if (!live || !progress) return null;
  const sec = Math.floor(progress.elapsedSec);
  return (
    <div className="df enc">
      <div className="prog">
        <div className="ln">
          <span>Recording the preview, edits included.</span>
          <span className="pc" role="timer" aria-label={`Recorded ${sec} seconds`}>
            {pad2(Math.floor(sec / 60))}:{pad2(sec % 60)}
          </span>
        </div>
        <TickMeter value={null} label="Recording" busyText="Recording" />
        <div className="ln">
          <span className="meta">
            Frame {progress.frames} · {live.width} × {live.height}
          </span>
          <span className="meta">MediaRecorder · {FORMAT_LABEL[progress.container]}</span>
        </div>
        <div className="ln acts">
          <Button onClick={cancelExport}>Discard</Button>
          <Button ref={stopRef} variant="primary" icon="stop" kbd={shortcutLabel('export.download')} stretch="grow" onClick={() => void stopRecording()}>
            Stop and save {FORMAT_LABEL[format]}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ExportError() {
  const error = useStore((s) => s.job.error);
  const setJob = useStore((s) => s.setJob);
  // Retrying after another file was opened would export that file instead.
  const sameMedia = useRuntime((r) => r.media === lastJobMedia());
  return (
    <div className="exp-err" role="alert">
      <Icon name="alert" />
      <div className="tx">
        <b>Export failed</b>
        <p>{error}</p>
      </div>
      {sameMedia && (
        <Button size="sm" onClick={() => void runExport()}>
          Try again
        </Button>
      )}
      <IconButton icon="x" size="sm" label="Dismiss" tooltip={false} onClick={() => setJob(IDLE_JOB)} />
    </div>
  );
}
