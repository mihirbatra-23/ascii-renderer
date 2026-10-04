/**
 * How parameter changes propagate (DOM-free), shared by the WebGL2 and CPU engines.
 *
 * Public API
 *   glyphKey(params)               identity of the glyph data: font, charset, line height. Only a
 *                                  change of this key rebuilds geometry, glyph vectors and atlases.
 *   affectsAnalysis(prev, next)    whether a change needs the analysis pass (and a §8 history
 *                                  reset); everything else is a compose-time uniform
 */
import type { RenderParams } from '../types';

export function glyphKey(p: Pick<RenderParams, 'font' | 'charsetPreset' | 'customCharset' | 'lineHeight'>): string {
  const custom = p.charsetPreset === 'custom' ? p.customCharset : '';
  return JSON.stringify([p.font, p.charsetPreset, custom, p.lineHeight]);
}

/** Read only by the compose pass. */
const COMPOSE_ONLY = new Set<keyof RenderParams>(['halftoneAngle', 'halftoneShape', 'shadowInk']);

/**
 * True when the per-cell analysis must re-run. The caller also resets the temporal history then:
 * otherwise a paused clip would blend the old and new settings and never converge, because a
 * still frame is not analysed again until something changes.
 */
export function affectsAnalysis(prev: RenderParams, next: RenderParams): boolean {
  for (const key of Object.keys(next) as (keyof RenderParams)[]) {
    if (prev[key] === next[key] || COMPOSE_ONLY.has(key)) continue;
    // Colour mode only changes the analysis of blocks (two-colour fit); other modes always
    // compute the mean cell colour.
    if (key === 'colorMode' && prev.mode !== 'blocks' && next.mode !== 'blocks') continue;
    return true;
  }
  return false;
}
