/**
 * Anchored popover layer used by Select, MenuButton and the color swatches: rendered in a portal
 * (so the dock's scroll container never clips it), 4 px below its anchor, flipped above when there
 * is no room, kept inside the viewport. Closes on outside pointerdown, Escape, resize and (unless
 * `closeOnTab` is off) Tab.
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { clamp, cx } from './util';

const GAP = 4;
const EDGE = 8;

export interface PopoverProps {
  anchor: HTMLElement | null;
  open: boolean;
  /** `focusAnchor` is true when focus should return to the anchor (Escape, selection). */
  onClose(focusAnchor: boolean): void;
  align?: 'start' | 'end';
  /**
   * Tab closes it and moves on from the anchor (menus, listboxes: one focus stop). Off for a
   * popover with several controls, which keeps Tab inside itself (the color popover).
   */
  closeOnTab?: boolean;
  className?: string;
  children: ReactNode;
}

export function Popover({ anchor, open, onClose, align = 'start', closeOnTab = true, className, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !anchor || !el) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const roomBelow = window.innerHeight - r.bottom - GAP - EDGE;
      const top = roomBelow >= h || r.top < h + GAP + EDGE ? r.bottom + GAP : r.top - GAP - h;
      const left = clamp(align === 'end' ? r.right - w : r.left, EDGE, window.innerWidth - w - EDGE);
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
    };
    place();
    window.addEventListener('scroll', place, true);
    return () => window.removeEventListener('scroll', place, true);
  }, [open, anchor, align]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor?.contains(t)) closeRef.current(false);
    };
    const onResize = () => closeRef.current(false);
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, anchor]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      className={cx('popover', className)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // Stop here so the global Escape (close Export) does not fire as well.
          e.stopPropagation();
          closeRef.current(true);
        } else if (e.key === 'Tab' && closeOnTab) {
          // Back on the anchor before the default Tab runs, so focus moves on from there.
          closeRef.current(true);
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
