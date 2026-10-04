/**
 * Size (spec §4.4, §7): the scale segment with exact pixels per option, Custom (any width; a width
 * between whole scales is resampled from the next one up), and the output card: readout, aspect
 * glyph, the check line computed from integers, and Grid / Glyph (Frames for motion) / Est. size.
 *
 * PNG and the motion formats keep separate scale settings (motion defaults to 1×), and a scale the
 * device cannot draw is never shown as chosen: the card shows the scale that will be written and
 * says why.
 */
import { useId } from 'react';
import { useRuntime } from '../../app/runtime';
import { selectIsLive, useStore, type ExportScale } from '../../state/store';
import { Icon } from '../icons';
import { NumberField, Section, Segmented, cx, type SegmentedOption } from '../kit';
import { LARGE_FILE_BYTES, type PanelEstimate } from './estimate';
import { exportRange, motionFrameCount, useFrameTimes } from './frameCount';
import { FORMAT_LABEL, SCALE_STEPS, formatByteRange, formatBytes, isMotion, isRaster, minCustomWidth, nearestScale, scaleSetting, type ExportPlan } from './sizing';

/** Thin spaces keep '2560 × 1440' inside a quarter of the 304 px dock. */
const dims = (w: number, h: number) => `${w} × ${h}`;

/** Cell sizes are whole pixels except after a custom-width resample: two decimals at most. */
const px = (v: number) => String(Number(v.toFixed(2)));

/**
 * Exporter notes the panel already gives in its own words: video padding (the card), the custom-width
 * resample (the width hint), a large file (the warning below the card) and live recording (Format).
 */
const SHOWN_NOTES = [/^Padded to /, /^Rendered at \d+× and resampled/, /^(Up to about|About) [\d.]+ MB: /, /^Recorded in real time until you stop it/];

export default function SizeSection({ plan, estimate }: { plan: ExportPlan | null; estimate: PanelEstimate }) {
  if (!plan) {
    return (
      <Section title="Size">
        <p className="hint">Sizes appear once the first frame has rendered.</p>
      </Section>
    );
  }
  const raster = isRaster(plan.format);
  // The large-file warning follows what the file may reach: the upper bound when there is a range.
  const most = estimate.range?.[1] ?? estimate.bytes;
  const aux =
    plan.format === 'txt' ? undefined : (
      <>
        <em>cell</em> {px(plan.cell.width)} × {px(plan.cell.height)} px
      </>
    );
  return (
    <Section title="Size" aux={aux}>
      {raster && <ScalePicker plan={plan} />}
      <OutputCard plan={plan} estimate={estimate} />
      {most !== null && most > LARGE_FILE_BYTES && <LargeFileHint plan={plan} bytes={most} upTo={estimate.range !== null} />}
      {estimate.notes
        .filter((n) => !SHOWN_NOTES.some((shown) => shown.test(n)))
        .map((note) => (
          <p key={note} className="hint">
            {note}
          </p>
        ))}
    </Section>
  );
}

function ScalePicker({ plan }: { plan: ExportPlan }) {
  const ui = useStore((s) => s.exportUi);
  const setExportUi = useStore((s) => s.setExportUi);
  const widthId = useId();
  const { base, maxScale, format } = plan;
  const setting = scaleSetting(ui, format);
  // What is written, not what was once picked: a stale 4× on a large grid shows its fallback.
  const shown: ExportScale = setting === 'custom' ? 'custom' : (SCALE_STEPS.find((s) => s === plan.renderScale) ?? 1);
  const options: SegmentedOption<ExportScale>[] = [
    ...SCALE_STEPS.map((s) => ({ value: s, label: `${s}×`, sub: dims(base.width * s, base.height * s), disabled: s > maxScale })),
    { value: 'custom', label: 'Custom', sub: setting === 'custom' ? dims(plan.raster.width, plan.raster.height) : 'W × H' },
  ];
  const write = (value: ExportScale) => (isMotion(format) ? { motionScale: value } : { scale: value });
  const choose = (value: ExportScale) =>
    setExportUi(value === 'custom' ? { ...write(value), customWidth: ui.customWidth ?? plan.raster.width } : write(value));
  const tooLarge = plan.scaleTooLarge;
  return (
    <>
      <Segmented variant="two" full label="Scale" options={options} value={shown} onChange={choose} />
      {tooLarge && (
        <p className="hint">
          {tooLarge.scale}× would be {dims(tooLarge.width, tooLarge.height)} px, more than this device can draw, so{' '}
          <b>{plan.renderScale}×</b> is used.
        </p>
      )}
      {setting === 'custom' && (
        <div className="cwrow">
          <label htmlFor={widthId}>Width</label>
          <NumberField
            id={widthId}
            value={plan.raster.width}
            min={minCustomWidth(plan.grid, base)}
            max={base.width * Math.max(1, maxScale)}
            step={1}
            format={(v) => String(Math.round(v))}
            onChange={(w) => setExportUi({ customWidth: Math.round(w) })}
            aria-label="Custom width in px"
          />
          <span className="u">px</span>
          <span className="res">{dims(plan.raster.width, plan.raster.height)}</span>
          <CustomHint plan={plan} onUseScale={(s) => setExportUi(write(s))} />
        </div>
      )}
    </>
  );
}

/** Whole-pixel cells or a resample, and the nearest whole scale as a one-click alternative. */
function CustomHint({ plan, onUseScale }: { plan: ExportPlan; onUseScale(scale: ExportScale): void }) {
  if (plan.targetWidth === undefined) {
    return <p className="hint">A whole multiple of the grid: every cell stays whole pixels.</p>;
  }
  const near = nearestScale(plan);
  return (
    <p className="hint">
      Resampled from {plan.renderScale}×, so cells are {px(plan.cell.width)} × {px(plan.cell.height)} px and edges soften slightly.{' '}
      <button type="button" className="lnk" onClick={() => onUseScale(near)}>
        Use {near}×
      </button>{' '}
      ({dims(plan.base.width * near, plan.base.height * near)}) for crisp cells.
    </p>
  );
}

function OutputCard({ plan, estimate }: { plan: ExportPlan; estimate: PanelEstimate }) {
  const { grid } = plan;
  const text = plan.format === 'txt';
  const motion = isMotion(plan.format);
  const label = text ? `Output ${grid.cols} by ${grid.rows} characters` : `Output ${plan.width} by ${plan.height} pixels`;
  const live = useStore(selectIsLive);
  const size =
    estimate.bytes === null ? '–' : `${estimate.approx ? '≈ ' : ''}${estimate.range ? formatByteRange(...estimate.range) : formatBytes(estimate.bytes)}`;
  const unknownWhy = live && motion ? 'Grows while you record' : 'Measured once the settings settle';
  return (
    <div className="outcard">
      <div className="top3">
        <span className="px" role="img" aria-label={label}>
          {text ? grid.cols : plan.width}
          <span className="x">×</span>
          {text ? grid.rows : plan.height}
          <small>{text ? 'chars' : 'px'}</small>
        </span>
        {!text && <AspectGlyph plan={plan} />}
      </div>
      <CheckLine plan={plan} />
      {plan.padded && (
        <p className="check">
          <Icon name="info" />
          <span>
            {FORMAT_LABEL[plan.format]} needs even sizes, so it is padded to <b>{plan.width} × {plan.height}</b> with paper on the right
            and bottom. Nothing is scaled.
          </span>
        </p>
      )}
      <dl className="facts3">
        <div>
          <dt>Grid</dt>
          <dd>
            {grid.cols} × {grid.rows}
          </dd>
        </div>
        <div>
          {motion ? (
            <>
              <dt>Frames</dt>
              <dd>
                <MotionFrames plan={plan} />
              </dd>
            </>
          ) : (
            <>
              <dt>Glyph</dt>
              <dd>{px(plan.glyphPx)} px</dd>
            </>
          )}
        </div>
        <div>
          <dt>Est. size</dt>
          <dd title={estimate.bytes === null ? unknownWhy : undefined}>{size}</dd>
        </div>
      </dl>
    </div>
  );
}

/** Large files: say so before the encode (on the estimate's upper bound), with the levers that shrink them. */
function LargeFileHint({ plan, bytes, upTo }: { plan: ExportPlan; bytes: number; upTo: boolean }) {
  const levers = isMotion(plan.format)
    ? `A smaller scale, fewer columns${plan.format === 'gif' ? ', MP4 instead of GIF' : ''} or a trimmed range make it smaller.`
    : 'A smaller scale or fewer columns make it smaller.';
  return (
    <p className="check warn note">
      <Icon name="alert" />
      <span>
        {upTo ? 'Up to about' : 'About'} <b>{formatBytes(bytes)}</b>: larger than many sites and chat apps accept (often 10–25 MB). {levers}
      </span>
    </p>
  );
}

/** Solid: the output. Dashed: the source at the same pixel scale. Both fitted into 64 × 40. */
function AspectGlyph({ plan }: { plan: ExportPlan }) {
  const out = plan.raster;
  const src = plan.source;
  const k = Math.min(64 / Math.max(out.width, src?.width ?? 0), 40 / Math.max(out.height, src?.height ?? 0));
  const box = (w: number, h: number) => ({ width: Math.max(2, Math.round(w * k)), height: Math.max(2, Math.round(h * k)) });
  return (
    <span className="aspect" title="Output (solid) against the source size (dashed)" aria-hidden="true">
      <span className="o" style={box(out.width, out.height)} />
      {src && <span className="s" style={box(src.width, src.height)} />}
    </span>
  );
}

function CheckLine({ plan }: { plan: ExportPlan }) {
  const setParam = useStore((s) => s.setParam);
  const { kind, text, fixColumns } = plan.check;
  const icon = kind === 'warn' ? 'alert' : kind === 'text' ? 'info' : 'check';
  return (
    <p className={cx('check', kind === 'warn' && 'warn')}>
      <Icon name={icon} />
      <span>
        {text}
        {fixColumns !== undefined && (
          <>
            {' '}
            <button type="button" className="lnk" onClick={() => setParam('columns', fixColumns)}>
              Use {fixColumns} columns
            </button>{' '}
            for an exact match.
          </>
        )}
      </span>
    </p>
  );
}

function MotionFrames({ plan }: { plan: ExportPlan }) {
  const media = useRuntime((r) => r.media);
  const trimOnly = useStore((s) => s.exportUi.trimOnly);
  const fps = useStore((s) => s.exportUi.fps);
  const inPoint = useStore((s) => s.playback.inPoint);
  const outPoint = useStore((s) => s.playback.outPoint);
  const duration = useStore((s) => s.playback.duration);
  const frameTimes = useFrameTimes();
  if (!media || media.kind === 'image') return <>–</>;
  // A camera is recorded until stopped: there is no count to give.
  if (media.kind === 'video' && media.live) return <>Live</>;
  const range = exportRange(trimOnly, inPoint, outPoint);
  const seconds = (range.endSec ?? duration) - (range.startSec ?? 0);
  const frames = motionFrameCount(media, plan.format, range, fps, frameTimes);
  return (
    <>
      {frames.approx ? '≈\u2009' : ''}
      {frames.count}
      {' · '}
      {Math.max(0, seconds).toFixed(2)} s
    </>
  );
}
