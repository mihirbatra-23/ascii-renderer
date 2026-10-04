/**
 * What the stage shows about the pending export (dimension lines, caption, header label, status):
 * the export panel's own plan (ui/export/sizing), so every number on screen is the file's size,
 * whole-number scale, custom widths and even-size video padding included. TXT reports characters.
 */
import { runtime } from '../../app/runtime';
import type { ExportUiState } from '../../state/store';
import { planExport } from '../export/sizing';
import type { StageLayout } from './layout';

export interface ExportPreview {
  /** Pixel formats: output size in px. TXT: columns × rows. */
  width: number;
  height: number;
  unit: 'px' | 'chars';
  /** Output px per scale-1 px (1 for SVG / HTML / TXT). */
  scale: number;
  /** MP4 / WebM need even sizes: the extra column / row of paper added. */
  padded: { width: number; height: number } | null;
}

export function exportPreview(layout: StageLayout, ui: ExportUiState): ExportPreview {
  if (ui.format === 'txt') return { width: layout.cols, height: layout.rows, unit: 'chars', scale: 1, padded: null };
  const engine = runtime.get().engine;
  if (!engine) return { width: layout.outW, height: layout.outH, unit: 'px', scale: 1, padded: null };
  const geo = { cols: layout.cols, rows: layout.rows, geometry: engine.getGeometry(), maxRasterSize: engine.maxRasterSize };
  const plan = planExport(ui, geo, null);
  const padded = plan.padded ? { width: plan.width - plan.raster.width, height: plan.height - plan.raster.height } : null;
  return { width: plan.width, height: plan.height, unit: 'px', scale: plan.scale, padded };
}
