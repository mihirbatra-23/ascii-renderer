/**
 * Under-frame caption and the export dimension lines (spec §4.2, §4.4, §4.6, §7), all computed
 * from the real geometry:
 *
 *   editing  "Source 1280 × 720 · Output 1280 × 720 px at 1× · 🔒 Aspect locked 16:9"
 *            (⚠ and the delta when rounding the rows bends the aspect)
 *   split    "Split 50% · Drag the handle, or focus it and use ← → · Press S to toggle"
 *   export   "Source … · Output 2560 × 1440 px at 2× · ✓ No crop, no squash"
 *
 * <ExportDims /> replaces the rulers while Export is open: neutral technical-drawing lines with
 * the output size ("2560 px", "1440 px").
 *
 * On a narrow stage the caption keeps what matters most (stage.css container queries): the aspect
 * check stays, the source and then the output size give way.
 */
import { useStageLayout } from '../../app/engineHost';
import type { ExportFormat } from '../../export/types';
import { useStore } from '../../state/store';
import { Icon } from '../icons';
import { exportPreview } from './exportSize';
import { aspectDelta, dims, formatDelta, formatFps, formatRatio, formatScale } from './format';
import { visibleGrid } from './layout';

const CAPTION_GAP = 10;
const CAPTION_H = 16;
const CAPTION_MIN_W = 560;

export function Caption() {
  const layout = useStageLayout();
  const info = useStore((s) => s.media.info);
  const split = useStore((s) => (s.view.mode === 'split' ? s.view.split : null));
  const exportUi = useStore((s) => (s.exportUi.open ? s.exportUi : null));
  if (!layout || !info) return null;

  const { box } = layout;
  const vis = visibleGrid(layout);
  const top = Math.min(vis.y + vis.height + CAPTION_GAP, box.height - CAPTION_H);
  // A narrow frame (tall source) lends the caption the room to its right rather than clipping it.
  const width = Math.max(vis.width, Math.min(CAPTION_MIN_W, box.width - vis.x - CAPTION_GAP));
  const style = { transform: `translate(${vis.x}px, ${top}px)`, width };

  if (split !== null && !exportUi) {
    return (
      <p className="cap" style={style}>
        <span>
          Split <b>{Math.round(split * 100)}%</b>
        </span>
        <span className="cap-hint">
          Drag the handle, or focus it and use <b>← →</b>
        </span>
        <span className="r">
          Press <b>S</b> to toggle
        </span>
      </p>
    );
  }

  const source = (
    <span className="cap-src">
      Source <b>{dims(info.width, info.height)}</b>
      {info.kind !== 'image' && info.fps ? (
        <>
          {' '}
          at <b>{formatFps(info.fps)}</b>
        </>
      ) : null}
    </span>
  );

  if (exportUi) {
    const out = exportPreview(layout, exportUi);
    const d = aspectDelta(layout.outW, layout.outH, info.width, info.height);
    return (
      <p className="cap" style={style}>
        {source}
        {out.unit === 'chars' ? (
          <span className="cap-out">
            Output <b>{dims(out.width, out.height)}</b> characters
          </span>
        ) : (
          <span className="cap-out">
            Output <b>{dims(out.width, out.height)}</b> px at {formatScale(out.scale)}
          </span>
        )}
        {d !== 0 ? (
          <AspectWarning delta={d} rows={layout.rows} />
        ) : (
          <span className="ok">
            <Icon name="check" size={12} />
            {videoNote(exportUi.format, !!out.padded) ?? 'No crop, no squash'}
          </span>
        )}
      </p>
    );
  }

  const d = aspectDelta(layout.outW, layout.outH, info.width, info.height);
  return (
    <p className="cap" style={style}>
      {source}
      <span className="cap-out">
        Output <b>{dims(layout.outW, layout.outH)}</b> px at 1×
      </span>
      {d === 0 ? (
        <span className="ok">
          <Icon name="lock" size={12} />
          Aspect locked <b>{formatRatio(info.width, info.height)}</b>
        </span>
      ) : (
        <AspectWarning delta={d} rows={layout.rows} />
      )}
    </p>
  );
}

/** Video codecs need even sizes; say whether this one is already even or padded with paper. */
function videoNote(format: ExportFormat, padded: boolean): string | null {
  const codec = format === 'mp4' ? 'H.264' : format === 'webm' ? 'VP9' : null;
  if (!codec) return null;
  return padded ? `Padded to even size, ${codec}-safe` : `Even dimensions, ${codec}-safe`;
}

function AspectWarning({ delta, rows }: { delta: number; rows: number }) {
  return (
    <span className="ok warn" title={`The source does not divide into whole rows; ${rows} rows bend the aspect slightly.`}>
      <Icon name="alert" size={12} />
      Aspect <b>{formatDelta(delta)}</b> · rows round to <b>{rows}</b>
    </span>
  );
}

export function ExportDims() {
  const layout = useStageLayout();
  const exportUi = useStore((s) => (s.exportUi.open ? s.exportUi : null));
  if (!layout || !exportUi) return null;
  const out = exportPreview(layout, exportUi);
  const vis = visibleGrid(layout);
  const unit = out.unit === 'px' ? 'px' : null;
  return (
    <>
      <div className="dim w" aria-hidden="true" style={{ transform: `translate(${vis.x}px, ${Math.max(0, vis.y - 20)}px)`, width: vis.width }}>
        <span>{unit ? `${out.width} px` : `${out.width} col`}</span>
      </div>
      <div className="dim h" aria-hidden="true" style={{ transform: `translate(${Math.max(0, vis.x - 24)}px, ${vis.y}px)`, height: vis.height }}>
        <span>{unit ? `${out.height} px` : `${out.height} rows`}</span>
      </div>
    </>
  );
}
