/**
 * Tooltips (pass-2 spec §2): one g2 surface in two sizes, drawn in a portal so no overflow container
 * clips it.
 *
 *   label tip   one line plus optional shortcut chips, centred under its trigger (toolbar buttons,
 *               the Invert switch)
 *   note tip    a sentence up to 240 px wide, an optional range line generated from the control's
 *               min / max / step, and shortcut chips; it hangs under a label with the dotted
 *               indicator (`.has-tip`), its text edge on the label's text edge
 *
 *   <Tooltip label="Undo" shortcut="⌘Z"><button …/></Tooltip>
 *   <Tooltip body="Background color."><button …/></Tooltip>
 *
 *   const tip = useTip({ body: 'Rotates the dot grid.', range: formatRange(0, 90, 1, { unit: '°' }) });
 *   <label><TipLabel tip={tip}>Dot angle</TipLabel></label> <input {...tip.focus} /> {tip.node}
 *
 * Behaviour: hover waits 500 ms, and reopens at once within 600 ms of another tip closing; keyboard
 * focus (:focus-visible) shows it at once. It hides on pointerdown, scroll, Escape and while a
 * value is being dragged or scrubbed (html[data-adjusting]). Touch: a 450 ms long-press shows it
 * above the finger, and a tap on a dotted label shows it too (a label tap has nothing else to do).
 *
 * A label tip whose text is the trigger's own name is decorative (aria-hidden). Note tips, and
 * label tips that add something (`describe`), are linked to the control with aria-describedby
 * through a hidden copy of the text, which exists whether or not the tip is open.
 */
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { clamp, cx } from './util';

const HOVER_DELAY_MS = 500;
/** A tip opened within this long after another one closed skips the hover delay. */
const WARM_MS = 600;
const LONG_PRESS_MS = 450;
const TOUCH_SLOP_PX = 10;
const GAP = 6;
const EDGE = 8;
const NOTE_MAX = 240;
const NOTE_MIN = 60;
/** Note padding (10) + border (1): the tip's text starts where the label's text starts. */
const NOTE_INSET = 11;
const LINE_PX = 18;

let lastClosedAt = -Infinity;

export interface TipContent {
  /** A one-line label tip. */
  label?: string;
  /** A note tip (wins over `label`). */
  body?: ReactNode;
  /** Range line under a note, e.g. ['0.40', '2.50'] (see formatRange). */
  range?: readonly [string, string];
  /** Shortcut chip(s), e.g. 'I' or ['[', ']']. */
  shortcut?: string | readonly string[];
}

export interface TipOptions {
  /** Preferred side; a tip flips when there is no room. Touch always opens above the finger. */
  side?: 'top' | 'bottom';
  /** 'text': note under a dotted label; 'start': left edges aligned; 'center': centred. */
  align?: 'text' | 'start' | 'center';
  /** Link the text to the control with aria-describedby (default: notes yes, labels no). */
  describe?: boolean;
  /** A touch tap on the hover target shows the tip (dotted labels). */
  tap?: boolean;
}

/**
 * The range line in display format: decimals follow the step (at least 2 when it is fractional),
 * a bipolar track signs both ends, negatives use the minus sign (−), `unit` follows each number.
 */
export function formatRange(
  min: number,
  max: number,
  step: number,
  { bipolar = false, unit = '' }: { bipolar?: boolean; unit?: string } = {},
): [string, string] {
  const frac = String(step).split('.')[1]?.length ?? 0;
  const decimals = frac ? Math.max(2, frac) : 0;
  const fmt = (v: number) => {
    const s = `${Math.abs(v).toFixed(decimals)}${unit}`;
    if (v < 0) return `−${s}`;
    return bipolar && v > 0 ? `+${s}` : s;
  };
  return [fmt(min), fmt(max)];
}

const keysOf = (shortcut: TipContent['shortcut']): readonly string[] =>
  shortcut === undefined ? [] : typeof shortcut === 'string' ? [shortcut] : shortcut;

const adjusting = () => document.documentElement.hasAttribute('data-adjusting');

export interface TipController {
  open: boolean;
  /** The element the tip is placed against (a dotted label, a switch, a button). */
  anchorRef(el: HTMLElement | null): void;
  /** Hover / touch handlers for the element the pointer rests on. */
  hover: {
    onPointerEnter(e: ReactPointerEvent): void;
    onPointerLeave(e: ReactPointerEvent): void;
    onPointerDown(e: ReactPointerEvent): void;
  };
  /** Focus handlers and the description link for the focusable control. */
  focus: {
    onFocus(e: FocusEvent): void;
    onBlur(e: FocusEvent): void;
    'aria-describedby'?: string;
  };
  /** The portal (while open) and the hidden description: render it anywhere in the trigger's tree. */
  node: ReactNode;
}

export function useTip(content: TipContent | null | undefined, options: TipOptions = {}): TipController {
  const id = useId();
  const anchor = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [open, setOpen] = useState<false | 'pointer' | 'touch'>(false);
  const openRef = useRef(open);
  openRef.current = open;

  const note = content?.body !== undefined;
  const { side = 'bottom', align = note ? 'text' : 'center', tap = false } = options;
  const describe = Boolean(content) && (options.describe ?? note);
  const descId = `${id}-d`;

  const anchorRef = useCallback((el: HTMLElement | null) => {
    anchor.current = el;
  }, []);
  const cancel = () => clearTimeout(timer.current);
  const show = (delay: number, how: 'pointer' | 'touch' = 'pointer') => {
    cancel();
    if (!content) return;
    const go = () => !adjusting() && setOpen(how);
    if (delay <= 0) go();
    else timer.current = setTimeout(go, delay);
  };
  const hide = () => {
    cancel();
    if (openRef.current) lastClosedAt = performance.now();
    setOpen(false);
  };
  const warmDelay = () => (performance.now() - lastClosedAt < WARM_MS ? 0 : HOVER_DELAY_MS);

  useEffect(() => cancel, []);

  // While open: Escape, scroll and the start of a drag or scrub close it; so does a touch elsewhere.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    const onDown = (e: PointerEvent) => {
      if (open === 'touch' && anchor.current?.contains(e.target as Node)) return;
      hide();
    };
    const watch = new MutationObserver(() => adjusting() && hide());
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-adjusting'] });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      watch.disconnect();
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
    // `hide` only touches refs and setters.
  }, [open]);

  useLayoutEffect(() => {
    const el = anchor.current;
    const tip = tipRef.current;
    if (!open || !el || !tip) return;
    if (note) fitNote(tip);
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const above = r.top - GAP - h;
    const below = r.bottom + GAP;
    const fitsBelow = below + h <= window.innerHeight - EDGE;
    const top = open === 'touch' || side === 'top' ? (above >= EDGE ? above : below) : fitsBelow || above < EDGE ? below : above;
    const left = align === 'center' ? r.left + r.width / 2 - w / 2 : align === 'text' ? r.left - NOTE_INSET : r.left;
    tip.style.transform = `translate(${Math.round(clamp(left, EDGE, window.innerWidth - w - EDGE))}px, ${Math.round(top)}px)`;
  }, [open, side, align, note]);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse') return hide();
    // Touch and pen: a long-press shows the tip above the finger; a tap does too on dotted labels.
    cancel();
    const sx = e.clientX;
    const sy = e.clientY;
    let shown = false;
    const off = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', off, true);
    };
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > TOUCH_SLOP_PX) {
        cancel();
        off();
      }
    };
    const up = () => {
      off();
      if (!shown) {
        cancel();
        if (tap) {
          shown = true;
          show(0, 'touch');
        }
      }
      // The press was for the tip: the click that follows must not toggle or activate anything.
      if (shown) swallowNextClick();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', off, true);
    timer.current = setTimeout(() => {
      shown = true;
      if (!adjusting()) setOpen('touch');
    }, LONG_PRESS_MS);
  };

  const keys = keysOf(content?.shortcut);
  const range = content?.range;
  const tip =
    open && content
      ? createPortal(
          note ? (
            <div ref={tipRef} className="tip note" aria-hidden="true" style={{ left: 0, top: 0 }}>
              <p>{content.body}</p>
              {(range || keys.length > 0) && (
                <div className="tm">
                  {range && (
                    <>
                      <b>{range[0]}</b> to <b>{range[1]}</b>
                    </>
                  )}
                  <span className="sp" />
                  {keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div ref={tipRef} className="tip" aria-hidden="true" style={{ left: 0, top: 0 }}>
              {content.label}
              {keys.map((k) => (
                <kbd key={k}>{k}</kbd>
              ))}
            </div>
          ),
          document.body,
        )
      : null;

  return {
    open: Boolean(open),
    anchorRef,
    hover: {
      onPointerEnter: (e) => e.pointerType === 'mouse' && show(warmDelay()),
      onPointerLeave: (e) => e.pointerType === 'mouse' && hide(),
      onPointerDown,
    },
    focus: {
      onFocus: (e) => (e.target as Element).matches(':focus-visible') && show(0),
      onBlur: hide,
      'aria-describedby': describe ? descId : undefined,
    },
    node: (
      <>
        {describe && content && (
          <span id={descId} hidden>
            {note ? content.body : content.label}
            {range && ` ${range[0]} to ${range[1]}.`}
          </span>
        )}
        {tip}
      </>
    ),
  };
}

/** Narrowest width up to 240 px that keeps the line count the note has at 240 px (measured once). */
function fitNote(tip: HTMLElement): void {
  tip.style.width = '';
  const p = tip.querySelector('p');
  if (!p || tip.offsetWidth < NOTE_MAX - 1) return;
  const meta = tip.querySelector<HTMLElement>('.tm');
  const lines = () => Math.round(p.getBoundingClientRect().height / LINE_PX);
  const metaFits = () => !meta || meta.scrollWidth <= meta.clientWidth + 0.5;
  const n = lines();
  let lo = NOTE_MIN;
  let hi = NOTE_MAX;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    tip.style.width = `${mid}px`;
    if (lines() > n || !metaFits()) lo = mid + 1;
    else hi = mid;
  }
  tip.style.width = `${Math.min(NOTE_MAX, lo + 1)}px`;
}

function swallowNextClick(): void {
  const stop = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener('click', stop, true);
  };
  window.addEventListener('click', stop, true);
  // A long-press may end without a click (the browser shows its own menu instead).
  setTimeout(() => window.removeEventListener('click', stop, true), 400);
}

/**
 * The `tooltip` prop of the kit's rows (SliderRow, HeroSlider, SwitchRow): a sentence, or a sentence
 * with shortcut chips. Slider rows add the range line from their own min / max / step unless
 * `range` is false; `unit` follows each end (Dot angle: '°').
 */
export type RowTooltip = string | { body: ReactNode; shortcut?: string | readonly string[]; unit?: string; range?: boolean };

export function rowTip(tooltip: RowTooltip | undefined): Exclude<RowTooltip, string> | undefined {
  return typeof tooltip === 'string' ? { body: tooltip } : tooltip;
}

/** A label's text with the dotted tooltip indicator; it is the tip's hover target and anchor. */
export function TipLabel({ tip, className, children }: { tip: TipController; className?: string; children: ReactNode }) {
  return (
    <span ref={tip.anchorRef} className={cx('has-tip', tip.open && 'on', className)} {...tip.hover}>
      {children}
    </span>
  );
}

export interface TooltipProps extends TipContent, Pick<TipOptions, 'side' | 'align' | 'describe'> {
  /** One focusable element (it gets aria-describedby when the tip describes it). */
  children: ReactNode;
}

/** A tip on one trigger element, which is both the hover target and the focus target. */
export function Tooltip({ label, body, range, shortcut, side, align, describe, children }: TooltipProps) {
  const wrap = useRef<HTMLSpanElement>(null);
  const tip = useTip({ label, body, range, shortcut }, { side, align, describe });
  useLayoutEffect(() => {
    tip.anchorRef(wrap.current?.firstElementChild as HTMLElement | null);
  });
  const describedBy = tip.focus['aria-describedby'];
  const child =
    describedBy && isValidElement(children)
      ? cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, { 'aria-describedby': describedBy })
      : children;
  return (
    <span ref={wrap} style={{ display: 'contents' }} {...tip.hover} onFocus={tip.focus.onFocus} onBlur={tip.focus.onBlur}>
      {child}
      {tip.node}
    </span>
  );
}
