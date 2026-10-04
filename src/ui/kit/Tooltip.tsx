/**
 * Hover / keyboard-focus tooltip: a label plus an optional shortcut, drawn in a portal so no
 * overflow container clips it. Hover waits 500 ms; keyboard focus shows it at once.
 *
 *   <Tooltip label="Undo" shortcut="⌘Z"><button …/></Tooltip>
 *
 * It is decorative for assistive tech (the trigger carries its own aria-label), so it is
 * aria-hidden rather than linked with aria-describedby, which would read the name twice.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { clamp } from './util';

const HOVER_DELAY_MS = 500;
const GAP = 6;
const EDGE = 8;

export interface TooltipProps {
  label: string;
  shortcut?: string;
  side?: 'top' | 'bottom';
  children: ReactNode;
}

export function Tooltip({ label, shortcut, side = 'bottom', children }: TooltipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [open, setOpen] = useState(false);

  const target = () => anchorRef.current?.firstElementChild as HTMLElement | null;
  const show = (delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', hide, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    const el = target();
    const tip = tipRef.current;
    if (!open || !el || !tip) return;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const below = r.bottom + GAP + h <= window.innerHeight - EDGE;
    const top = side === 'bottom' && below ? r.bottom + GAP : r.top - GAP - h >= EDGE ? r.top - GAP - h : r.bottom + GAP;
    const left = clamp(r.left + r.width / 2 - w / 2, EDGE, window.innerWidth - w - EDGE);
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }, [open, side]);

  return (
    <span
      ref={anchorRef}
      style={{ display: 'contents' }}
      onPointerEnter={(e) => e.pointerType === 'mouse' && show(HOVER_DELAY_MS)}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={() => target()?.matches(':focus-visible') && show(0)}
      onBlur={hide}
    >
      {children}
      {open &&
        createPortal(
          <div ref={tipRef} className="tip" aria-hidden="true" style={{ left: 0, top: 0 }}>
            {label}
            {shortcut && <kbd>{shortcut}</kbd>}
          </div>,
          document.body,
        )}
    </span>
  );
}
