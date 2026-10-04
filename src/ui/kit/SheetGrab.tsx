/**
 * Grabber for the phone bottom sheet (spec §2 "Phone sheet"): the sheet follows the finger 1:1
 * while dragged and snaps to the nearest detent on release. A tap, Enter or Space steps to the
 * next detent; ↑ ↓ move between detents.
 *
 * The sheet element's height comes from CSS (`--sheet-h`, set by the owner from `detent`);
 * during a drag this sets an inline px height plus `.is-dragging` on it, then hands back.
 */
import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

export interface SheetDetentSpec<T extends string> {
  id: T;
  label: string;
  /** Height in px for a container of the given height. */
  height(containerH: number): number;
}

export interface SheetGrabProps<T extends string> {
  sheetRef: RefObject<HTMLElement | null>;
  detents: readonly SheetDetentSpec<T>[];
  detent: T;
  onDetent(detent: T): void;
}

const TAP_SLOP_PX = 4;

export function SheetGrab<T extends string>({ sheetRef, detents, detent, onDetent }: SheetGrabProps<T>) {
  const index = Math.max(0, detents.findIndex((d) => d.id === detent));
  const dragging = useRef(false);

  const containerH = () => sheetRef.current?.parentElement?.clientHeight ?? window.innerHeight;

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    const sheet = sheetRef.current;
    if (!sheet || e.button !== 0) return;
    const grab = e.currentTarget;
    const pointerId = e.pointerId;
    grab.setPointerCapture(pointerId);
    const startY = e.clientY;
    const startH = sheet.getBoundingClientRect().height;
    const maxH = containerH();
    dragging.current = false;

    const move = (ev: globalThis.PointerEvent) => {
      const dy = ev.clientY - startY;
      if (!dragging.current && Math.abs(dy) < TAP_SLOP_PX) return;
      dragging.current = true;
      sheet.classList.add('is-dragging');
      sheet.style.height = `${Math.min(maxH, Math.max(48, startH - dy))}px`;
    };
    const end = () => {
      grab.removeEventListener('pointermove', move);
      grab.removeEventListener('pointerup', end);
      grab.removeEventListener('pointercancel', end);
      if (!dragging.current) return;
      const h = sheet.getBoundingClientRect().height;
      const nearest = detents.reduce((best, d) => (Math.abs(d.height(maxH) - h) < Math.abs(best.height(maxH) - h) ? d : best));
      sheet.classList.remove('is-dragging');
      sheet.style.height = '';
      onDetent(nearest.id);
    };
    grab.addEventListener('pointermove', move);
    grab.addEventListener('pointerup', end);
    grab.addEventListener('pointercancel', end);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = detents[Math.min(detents.length - 1, Math.max(0, index + step))];
    if (next) onDetent(next.id);
  };

  return (
    <button
      type="button"
      className="grab"
      aria-label={`Panel size: ${detents[index]?.label}. Press to resize.`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onClick={() => {
        // A drag also ends in a click; only a tap (or the keyboard) steps the detent.
        if (dragging.current) return;
        onDetent(detents[(index + 1) % detents.length].id);
      }}
    />
  );
}
