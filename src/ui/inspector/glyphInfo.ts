/**
 * Glyph facts for the dock, measured with the engine's own code so they agree with the render:
 *
 *   useCellGeometry()      the cell (cellW × cellH, font size) for the current font and line
 *                          height (ALGORITHM §1); exact once the font has loaded
 *   useGlyphsByDensity()   the current charset sorted light to dark by measured coverage, which
 *                          is the ramp order of §4 (in Ramp mode, only the glyphs Ramp uses: §6);
 *                          null until the first measurement lands
 */
import { useEffect, useMemo, useState } from 'react';
import { browserCanvasFactory } from '../../engine/canvas';
import { rampOrder } from '../../engine/charsets';
import { FONTS, loadFont } from '../../engine/fonts';
import { computeGeometry, measureFontMetrics, type FontMetrics } from '../../engine/geometry';
import { prepareAnalysis } from '../../engine/setup';
import type { CellGeometry, FontId } from '../../engine/types';
import { useStore } from '../../state/store';

// Every bundled font is a 0.6 em monospace; this stands in until the real metrics are measured.
const FALLBACK_METRICS: FontMetrics = { advanceEm: 0.6, ascentEm: 0.8, descentEm: 0.2 };
const metricsCache = new Map<FontId, FontMetrics>();

function useFontMetrics(font: FontId): FontMetrics {
  const [, setLoaded] = useState<FontId | null>(null);
  useEffect(() => {
    if (metricsCache.has(font)) return;
    let live = true;
    loadFont(font)
      .then(() => {
        metricsCache.set(font, measureFontMetrics(browserCanvasFactory(1, 1).ctx, FONTS[font].family));
        if (live) setLoaded(font);
      })
      .catch(() => {
        // The engine reports font failures; the readout keeps the nominal 0.6 em cell.
      });
    return () => {
      live = false;
    };
  }, [font]);
  return metricsCache.get(font) ?? FALLBACK_METRICS;
}

export function useCellGeometry(): CellGeometry {
  const font = useStore((s) => s.params.font);
  const lineHeight = useStore((s) => s.params.lineHeight);
  const metrics = useFontMetrics(font);
  return useMemo(() => computeGeometry(metrics, { lineHeight, family: FONTS[font].family }), [metrics, lineHeight, font]);
}

// Measuring rasterises every glyph, so wait until typing or a line-height drag settles.
const MEASURE_DELAY_MS = 150;
const MAX_CACHED = 32;
const densityCache = new Map<string, string>();

export function useGlyphsByDensity(): string | null {
  const font = useStore((s) => s.params.font);
  const lineHeight = useStore((s) => s.params.lineHeight);
  const charsetPreset = useStore((s) => s.params.charsetPreset);
  const customCharset = useStore((s) => (s.params.charsetPreset === 'custom' ? s.params.customCharset : ''));
  const ramp = useStore((s) => s.params.mode === 'ramp');
  const key = JSON.stringify([font, lineHeight, charsetPreset, customCharset, ramp]);
  // The last measurement this hook produced: shown while a newer one is pending.
  const [latest, setLatest] = useState<string | null>(null);

  useEffect(() => {
    if (densityCache.has(key)) return;
    let live = true;
    const timer = setTimeout(() => {
      loadFont(font)
        .then(() => {
          if (!live) return;
          const { glyphSet } = prepareAnalysis({ lineHeight, charsetPreset, customCharset }, FONTS[font].family, browserCanvasFactory);
          const candidates = new Set(ramp ? glyphSet.rampGlyphs : glyphSet.chars.keys());
          const order = Array.from(rampOrder(glyphSet.meanCoverage).filter((i) => candidates.has(i)), (i) => glyphSet.chars[i]);
          const text = order.filter((ch) => ch !== ' ').join('');
          if (densityCache.size >= MAX_CACHED) densityCache.delete(densityCache.keys().next().value!);
          densityCache.set(key, text);
          setLatest(text);
        })
        .catch(() => {
          // No font, no measurement: the preview keeps its last string.
        });
    }, MEASURE_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, font, lineHeight, charsetPreset, customCharset, ramp]);

  return densityCache.get(key) ?? latest;
}
