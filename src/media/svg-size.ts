/**
 * Raster size for an SVG, from the root element's width / height / viewBox. Parsed here because
 * <img>.naturalWidth is unreliable for SVGs (0 or 300×150 for viewBox-only files, browser-dependent).
 */

export interface PixelSize {
  width: number;
  height: number;
}

/** Long side used when the SVG has an aspect ratio (viewBox) but no absolute size. */
export const SVG_DEFAULT_LONG_SIDE = 2048;
/** Vector sources are rasterised at least this large so the analysis grid never upsamples them. */
export const SVG_MIN_LONG_SIDE = 1024;
/** ...and at most this large: beyond it extra pixels add nothing to an ASCII grid. */
export const SVG_MAX_LONG_SIDE = 4096;

const UNIT_PX: Record<string, number> = {
  '': 1,
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  em: 16,
  ex: 8,
};

export function svgRasterSize(svgText: string): PixelSize {
  const tag = /<svg\b([^>]*)>/i.exec(svgText)?.[1] ?? '';
  const width = parseLength(attribute(tag, 'width'));
  const height = parseLength(attribute(tag, 'height'));
  const viewBox = parseViewBox(attribute(tag, 'viewBox'));
  const aspect = viewBox ? viewBox.width / viewBox.height : width && height ? width / height : null;

  let size: PixelSize;
  if (width && height) size = { width, height };
  else if (width && aspect) size = { width, height: width / aspect };
  else if (height && aspect) size = { width: height * aspect, height };
  else if (aspect) {
    size = aspect >= 1
      ? { width: SVG_DEFAULT_LONG_SIDE, height: SVG_DEFAULT_LONG_SIDE / aspect }
      : { width: SVG_DEFAULT_LONG_SIDE * aspect, height: SVG_DEFAULT_LONG_SIDE };
  } else {
    // CSS default object size for replaced elements without intrinsic dimensions.
    size = { width: width ?? 300, height: height ?? 150 };
  }

  const longSide = Math.max(size.width, size.height);
  const scale = longSide < SVG_MIN_LONG_SIDE
    ? SVG_MIN_LONG_SIDE / longSide
    : longSide > SVG_MAX_LONG_SIDE ? SVG_MAX_LONG_SIDE / longSide : 1;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match ? (match[1] ?? match[2]).trim() : null;
}

/** Absolute lengths in CSS px; percentages and invalid values have no intrinsic size. */
function parseLength(value: string | null): number | null {
  const match = value ? /^([+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]*)$/i.exec(value) : null;
  if (!match) return null;
  const factor = UNIT_PX[match[2].toLowerCase()];
  const px = factor === undefined ? NaN : parseFloat(match[1]) * factor;
  return px > 0 && Number.isFinite(px) ? px : null;
}

function parseViewBox(value: string | null): PixelSize | null {
  const parts = value?.split(/[\s,]+/).filter(Boolean).map(Number) ?? [];
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [, , width, height] = parts;
  return width > 0 && height > 0 ? { width, height } : null;
}
