/**
 * Pointer intent for sideways controls (slider tracks, scrubbable labels and value fields) that
 * sit in a vertically scrolling panel, such as the phone's bottom sheet.
 *
 * A mouse means what it does at once. A finger or pen may be starting a scroll, so it has to show
 * its direction first: once it has moved `slop` px, mostly sideways means "adjust", anything else
 * belongs to the browser's pan (the controls are `touch-action: pan-y`), which ends the pointer
 * sequence with pointercancel.
 */

/** Movement a finger needs before its direction counts; small enough to feel immediate. */
export const TOUCH_SLOP_PX = 8;

export type Intent = 'pending' | 'adjust' | 'scroll';

/** Whether this pointer must show its direction before a control reacts to it. */
export function waitsForIntent(pointerType: string): boolean {
  return pointerType !== 'mouse';
}

/** The direction of a movement of (dx, dy) px from the press, once it is past `slop`. */
export function readIntent(dx: number, dy: number, slop: number): Intent {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < slop) return 'pending';
  return ax > ay ? 'adjust' : 'scroll';
}
