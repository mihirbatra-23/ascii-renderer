/**
 * Filmstrip thumbnails (spec §4.3): one canvas holding a halftone thumbnail per slot, drawn from
 * small snapshots spread across the clip. The snapshots come from sampleFramesForLevels, which
 * reads video through its own element, so sampling never disturbs playback.
 */
import type { FrameSource } from '../../engine/types';
import { sampleFramesForLevels, type LoadedAnimation, type LoadedVideo } from '../../media';

/** Dot pitch in CSS px (the boards draw 6 device px at 2×). */
const PITCH = 3;

const samples = new WeakMap<LoadedAnimation | LoadedVideo, Map<number, Promise<FrameSource[]>>>();

/**
 * `count` snapshots at the centres of equal slices of the clip, cached per media. Short
 * animations return every frame instead (fewer than `count`).
 */
export function sampleThumbs(media: LoadedAnimation | LoadedVideo, count: number): Promise<FrameSource[]> {
  let byCount = samples.get(media);
  if (!byCount) samples.set(media, (byCount = new Map()));
  const cached = byCount.get(count);
  if (cached) return cached;
  const request = sampleFramesForLevels(media, count);
  byCount.set(count, request);
  request.catch(() => byCount.delete(count));
  return request;
}

function sizeOf(f: FrameSource): { width: number; height: number } {
  if (f instanceof HTMLVideoElement) return { width: f.videoWidth, height: f.videoHeight };
  if (f instanceof HTMLImageElement) return { width: f.naturalWidth, height: f.naturalHeight };
  if ('displayWidth' in f) return { width: f.displayWidth, height: f.displayHeight };
  return { width: f.width, height: f.height };
}

let scratch: CanvasRenderingContext2D | null = null;

/** Mean luminance per dot: the frame cover-fitted into a cols × rows grid. */
function dotLevels(frame: FrameSource, cols: number, rows: number): Uint8ClampedArray {
  scratch ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const ctx = scratch;
  if (!ctx) return new Uint8ClampedArray(cols * rows * 4);
  ctx.canvas.width = cols;
  ctx.canvas.height = rows;
  ctx.imageSmoothingQuality = 'high';
  const { width: fw, height: fh } = sizeOf(frame);
  const k = Math.max(cols / fw, rows / fh);
  const sw = cols / k;
  const sh = rows / k;
  ctx.drawImage(frame, (fw - sw) / 2, (fh - sh) / 2, sw, sh, 0, 0, cols, rows);
  return ctx.getImageData(0, 0, cols, rows).data;
}

/**
 * Draws `frames.length` slots edge to edge across the canvas (device px). A null slot stays
 * paper. Dots grow with the square root of the tone, like the halftone mode.
 */
export function drawFilmstrip(canvas: HTMLCanvasElement, frames: readonly (FrameSource | null)[], paper: string, dpr: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width: W, height: H } = canvas;
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, W, H);
  const pitch = PITCH * dpr;
  const minR = 0.225 * dpr;
  frames.forEach((frame, k) => {
    if (!frame) return;
    const x0 = Math.round((k * W) / frames.length);
    const x1 = Math.round(((k + 1) * W) / frames.length);
    const cols = Math.ceil((x1 - x0) / pitch);
    const rows = Math.ceil(H / pitch);
    const rgba = dotLevels(frame, cols, rows);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, x1 - x0, H);
    ctx.clip();
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const p = (j * cols + i) * 4;
        const lum = (0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]) / 255;
        const c = Math.min(1, Math.max(0, (lum - 0.05) / 0.8));
        const r = pitch * 0.5 * Math.sqrt(c) * 1.05;
        if (r < minR) continue;
        const g = Math.round(60 + 170 * Math.min(1, c + 0.2));
        ctx.fillStyle = `rgb(${g} ${g} ${g})`;
        ctx.beginPath();
        ctx.arc(x0 + (i + 0.5) * pitch, (j + 0.5) * pitch, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  });
}
