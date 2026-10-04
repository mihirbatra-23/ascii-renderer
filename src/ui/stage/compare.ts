/**
 * What Split's left side shows. A plain Ramp render is the output itself when the output is Ramp
 * without contour lines (the ramp render never draws them), so "vs Ramp" is offered only when it
 * differs, and a stored "ramp" choice falls back to the original while it would not.
 */
import type { RenderParams } from '../../engine/types';
import type { CompareWith, ViewState } from '../../state/store';
import { hasEdgeLayer } from '../inspector/copy';

/** Why "Ramp render" is unavailable, or null when it shows something the output does not. */
export function rampCompareBlocked(params: Pick<RenderParams, 'mode' | 'edges'>): string | null {
  if (params.mode !== 'ramp' || (params.edges && hasEdgeLayer(params.mode))) return null;
  return 'Same as the output. Turn on contour lines or pick another mode.';
}

/** The comparison actually shown for the stored choice. */
export function effectiveCompare(view: Pick<ViewState, 'compareWith'>, params: Pick<RenderParams, 'mode' | 'edges'>): CompareWith {
  return view.compareWith === 'ramp' && rampCompareBlocked(params) ? 'source' : view.compareWith;
}
