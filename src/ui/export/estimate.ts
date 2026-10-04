/**
 * What the export will weigh and whether this browser can make it, recomputed (debounced) when
 * the settings change. SVG, TXT and HTML are measured exactly (the real file is built from the
 * grid, which is cheap). PNG, GIF and video sizes come from the exporters' own estimate
 * (`estimateExport`), which never renders the full raster on the main thread, and show as
 * approximate ("≈").
 */
import { useEffect, useState } from 'react';
import { runtime } from '../../app/runtime';
import type { RendererEngine } from '../../engine';
import { estimateExport, exportHtml, exportSvg, exportTxt, type GifDeltaSampler } from '../../export';
import type { ExportFormat, ExportOptions } from '../../export/types';
import { useStore, type ExportUiState } from '../../state/store';
import { snapshotEngine } from './exportJob';
import { exportRange } from './frameCount';
import { canBeTransparent, isMotion, isVideo, type ExportPlan } from './sizing';

export interface PanelEstimate {
  /** null while measuring, or when no estimate is available for this format here. */
  bytes: number | null;
  /** Low and high bounds when the sampled frames disagree (shown instead of one figure). */
  range: [number, number] | null;
  approx: boolean;
  notes: string[];
  supported: boolean;
}

const UNKNOWN: PanelEstimate = { bytes: null, range: null, approx: false, notes: [], supported: true };
const DEBOUNCE_MS = 300;

/** Above this a file no longer fits common upload limits (GitHub images 10 MB, chat apps 8–25 MB). */
export const LARGE_FILE_BYTES = 15_000_000;

type MeasureOptions = Pick<ExportUiState, 'margin' | 'transparent' | 'svgText'>;

/** Exact bytes of the vector and text files, built from the grid as the exporters build them. */
async function exactBytes(engine: RendererEngine, format: ExportFormat, ui: MeasureOptions): Promise<number | null> {
  const { margin, transparent } = ui;
  switch (format) {
    case 'svg':
      return (await exportSvg(engine.snapshot(), { margin, transparentBackground: transparent, svgText: ui.svgText })).blob.size;
    case 'txt':
      return exportTxt(engine.snapshot(), { lineEnding: '\n' }).blob.size;
    case 'html':
      return (await exportHtml(engine.snapshot(), { margin })).blob.size;
    default:
      return null;
  }
}

export function useExportEstimate(plan: ExportPlan | null): PanelEstimate {
  const params = useStore((s) => s.params);
  const margin = useStore((s) => s.exportUi.margin);
  const transparent = useStore((s) => s.exportUi.transparent);
  const svgText = useStore((s) => s.exportUi.svgText);
  const fps = useStore((s) => s.exportUi.fps);
  const includeAudio = useStore((s) => s.exportUi.includeAudio);
  const trimOnly = useStore((s) => s.exportUi.trimOnly);
  const inPoint = useStore((s) => s.playback.inPoint);
  const outPoint = useStore((s) => s.playback.outPoint);
  const [estimate, setEstimate] = useState<PanelEstimate & { plan?: ExportPlan }>(UNKNOWN);

  useEffect(() => {
    const { engine, media } = runtime.get();
    if (!plan || !engine || !media) return;
    let live = true;
    // Drops the exporters' sample render (async readback + worker encode) once superseded.
    const ac = new AbortController();
    const timer = setTimeout(async () => {
      const motion = isMotion(plan.format);
      const opts: ExportOptions = {
        format: plan.format,
        scale: plan.renderScale,
        targetWidth: plan.targetWidth,
        margin,
        transparentBackground: transparent && canBeTransparent(plan.format, params),
        lineEnding: '\n',
        svgText,
        ...(motion ? exportRange(trimOnly, inPoint, outPoint) : {}),
        // Only video sources are resampled to another rate (GIFs keep their own timing).
        fps: media.kind === 'video' && fps !== 'source' ? fps : undefined,
        includeAudio: includeAudio && isVideo(plan.format),
      };
      // A GIF from a clip measures real delta frames, rendered on an engine set up as the export's.
      const clip = media.kind !== 'image' && !(media.kind === 'video' && media.live) ? media : null;
      const gifSampler: GifDeltaSampler | undefined =
        plan.format === 'gif' && clip ? { params, engine: () => snapshotEngine(clip, { ...params }, ac.signal) } : undefined;
      try {
        const [est, exact] = await Promise.all([
          estimateExport(engine, media, opts, ac.signal, gifSampler),
          exactBytes(engine, plan.format, { margin, transparent, svgText }),
        ]);
        if (!live) return;
        const bytes = exact ?? est.bytes ?? null;
        setEstimate({ plan, bytes, range: exact === null ? (est.bytesRange ?? null) : null, approx: exact === null, notes: est.notes, supported: est.supported });
      } catch {
        // Nothing to measure yet (no frame on the engine): the size stays unknown.
        if (live) setEstimate(UNKNOWN);
      }
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      ac.abort();
    };
  }, [plan, params, margin, transparent, svgText, fps, includeAudio, trimOnly, inPoint, outPoint]);

  // A result for another plan (format, scale, size) is never shown, even for the moment before the new one lands.
  return estimate.plan === plan ? estimate : UNKNOWN;
}
