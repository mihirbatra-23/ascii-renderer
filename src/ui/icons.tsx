/**
 * Icon set (design spec §9): hand-drawn on a 16 px grid, 1.5 px stroke, round caps, currentColor.
 * `play` and `pause` are filled. Icons are decorative (aria-hidden): the label lives on the button.
 *
 *   <Icon name="undo" />            16 px (controls)
 *   <Icon name="lock" size={12} />  12 px (status bar, caption)
 *   <ModeSpecimen mode="braille" /> the mode-tile specimens (SVG, no font dependency)
 */
import type { RenderMode } from '../engine/types';

const STROKE = {
  upload: 'M8 10V2.75M4.75 6 8 2.75 11.25 6M2.75 10.5v1.75c0 .55.45 1 1 1h8.5c.55 0 1-.45 1-1V10.5',
  download: 'M8 2.75V10M4.75 6.75 8 10l3.25-3.25M2.75 10.5v1.75c0 .55.45 1 1 1h8.5c.55 0 1-.45 1-1V10.5',
  export: 'M8 9.25v-6.5M5.5 5.25 8 2.75l2.5 2.5M5.75 7H4.25c-.55 0-1 .45-1 1v4.25c0 .55.45 1 1 1h7.5c.55 0 1-.45 1-1V8c0-.55-.45-1-1-1h-1.5',
  folder: 'M2.25 4.75c0-.55.45-1 1-1h2.9l1.4 1.5h5.2c.55 0 1 .45 1 1v5.5c0 .55-.45 1-1 1H3.25c-.55 0-1-.45-1-1z',
  paste: 'M5.75 3.25h-1.5c-.55 0-1 .45-1 1v8.5c0 .55.45 1 1 1h7.5c.55 0 1-.45 1-1v-8.5c0-.55-.45-1-1-1h-1.5M6.25 2.25h3.5v2h-3.5z',
  link: 'M6.75 9.25l2.5-2.5M7.25 4.75l.9-.9a2.47 2.47 0 0 1 3.5 3.5l-.9.9M8.75 11.25l-.9.9a2.47 2.47 0 0 1-3.5-3.5l.9-.9',
  x: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  undo: 'M5.75 3.75 3 6.5l2.75 2.75M3 6.5h6.75a3.25 3.25 0 0 1 0 6.5H8',
  redo: 'M10.25 3.75 13 6.5l-2.75 2.75M13 6.5H6.25a3.25 3.25 0 0 0 0 6.5H8',
  branch:
    'M5 4.75v6.5M5 11.25a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM5 1.75a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM11 3.75a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM11 6.75c0 2.5-6 2-6 4.5',
  grid: 'M6 2.75v10.5M10 2.75v10.5M2.75 6h10.5M2.75 10h10.5',
  minus: 'M3.75 8h8.5',
  plus: 'M8 3.75v8.5M3.75 8h8.5',
  fit: 'M2.75 6V3.75c0-.55.45-1 1-1H6M10 2.75h2.25c.55 0 1 .45 1 1V6M13.25 10v2.25c0 .55-.45 1-1 1H10M6 13.25H3.75c-.55 0-1-.45-1-1V10',
  split: 'M3.75 2.75h8.5c.55 0 1 .45 1 1v8.5c0 .55-.45 1-1 1h-8.5c-.55 0-1-.45-1-1v-8.5c0-.55.45-1 1-1zM8 2.75v10.5',
  image:
    'M3.75 2.75h8.5c.55 0 1 .45 1 1v8.5c0 .55-.45 1-1 1h-8.5c-.55 0-1-.45-1-1v-8.5c0-.55.45-1 1-1zM2.75 11l3-3 2.5 2.5 1.75-1.75 3.25 3.25M10.25 4.75a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
  film: 'M3.75 2.75h8.5c.55 0 1 .45 1 1v8.5c0 .55-.45 1-1 1h-8.5c-.55 0-1-.45-1-1v-8.5c0-.55.45-1 1-1zM5.25 2.75v10.5M10.75 2.75v10.5M2.75 6h2.5M2.75 10h2.5M10.75 6h2.5M10.75 10h2.5',
  prev: 'M4.25 3.75v8.5M11.75 4.2v7.6a.4.4 0 0 1-.63.33L6.1 8.33a.4.4 0 0 1 0-.66l5.02-3.8a.4.4 0 0 1 .63.33z',
  next: 'M11.75 3.75v8.5M4.25 4.2v7.6a.4.4 0 0 0 .63.33l5.02-3.8a.4.4 0 0 0 0-.66L4.88 3.87a.4.4 0 0 0-.63.33z',
  loop: 'M2.75 7.25v-.5a2 2 0 0 1 2-2h8M10.75 2.75l2 2-2 2M13.25 8.75v.5a2 2 0 0 1-2 2h-8M5.25 13.25l-2-2 2-2',
  reset: 'M2.75 2.75v3h3M3.1 5.75A5.25 5.25 0 1 1 2.9 9.5',
  check: 'M3.25 8.5l3 3 6.5-6.75',
  'chev-d': 'M4.5 6.25 8 9.75l3.5-3.5',
  'chev-r': 'M6.25 4.5 9.75 8l-3.5 3.5',
  'arrow-l': 'M12.75 8h-9.5M7.25 4l-4 4 4 4',
  lock: 'M4.25 7.25h7.5c.55 0 1 .45 1 1v4.5c0 .55-.45 1-1 1h-7.5c-.55 0-1-.45-1-1v-4.5c0-.55.45-1 1-1zM5.5 7.25V5.5a2.5 2.5 0 0 1 5 0v1.75',
  alert: 'M8 2.75 14 13.25H2zM8 6.75v3M8 11.6v.01',
  info: 'M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5zM8 7.25v4M8 4.9v.01',
  copy: 'M6.25 5.75h6c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1h-6c-.55 0-1-.45-1-1v-6c0-.55.45-1 1-1zM10.25 5.75v-2c0-.55-.45-1-1-1h-5.5c-.55 0-1 .45-1 1v5.5c0 .55.45 1 1 1h1.5',
  keyboard:
    'M2.75 4.25h10.5c.55 0 1 .45 1 1v5.5c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1v-5.5c0-.55.45-1 1-1zM4.75 7h.01M7 7h.01M9 7h.01M11.25 7h.01M5.5 9.5h5',
  'arrows-lr': 'M5.5 5.25 2.75 8l2.75 2.75M10.5 5.25 13.25 8l-2.75 2.75',
  'file-x': 'M9.25 1.75H4.75c-.55 0-1 .45-1 1v10.5c0 .55.45 1 1 1h6.5c.55 0 1-.45 1-1V4.75zM9.25 1.75v3h3M6.5 8.25l3 3M9.5 8.25l-3 3',
  more: 'M3.75 8h.01M8 8h.01M12.25 8h.01',
  sliders: 'M2.75 5h6.5M12.25 5h1M2.75 11h1M6.75 11h6.5M10.75 3.5v3M5.25 9.5v3',
  type: 'M3.25 4.25v-1.5h9.5v1.5M8 2.75v10.5M6 13.25h4',
  drop: 'M8 2.25c2.5 3 4.25 5.1 4.25 7.25a4.25 4.25 0 0 1-8.5 0C3.75 7.35 5.5 5.25 8 2.25z',
  camera: 'M2.75 4.75h7c.55 0 1 .45 1 1v4.5c0 .55-.45 1-1 1h-7c-.55 0-1-.45-1-1v-4.5c0-.55.45-1 1-1zM10.75 7l2.5-1.5v5l-2.5-1.5',
} as const;

const FILLED = {
  play: 'M5 3.4v9.2c0 .4.43.64.77.43l7.2-4.6a.5.5 0 0 0 0-.86l-7.2-4.6A.5.5 0 0 0 5 3.4z',
  pause: 'M4.5 3.25h2.25v9.5H4.5zM9.25 3.25h2.25v9.5H9.25z',
  /** Start recording a live source. */
  record: 'M8 3.75a4.25 4.25 0 1 0 0 8.5 4.25 4.25 0 0 0 0-8.5z',
  /** Stop a recording. */
  stop: 'M5 4.25h6c.41 0 .75.34.75.75v6c0 .41-.34.75-.75.75H5a.75.75 0 0 1-.75-.75V5c0-.41.34-.75.75-.75z',
} as const;

export type IconName = keyof typeof STROKE | keyof typeof FILLED;

export const ICON_NAMES = [...Object.keys(STROKE), ...Object.keys(FILLED)] as IconName[];

export interface IconProps {
  name: IconName;
  /** 16 in controls, 12 in the status bar and caption, 20 only for larger targets. */
  size?: 12 | 14 | 16 | 20;
  className?: string;
}

export function Icon({ name, size = 16, className }: IconProps) {
  const filled = name in FILLED;
  const d = filled ? FILLED[name as keyof typeof FILLED] : STROKE[name as keyof typeof STROKE];
  const cls = ['i', filled && 'f', className].filter(Boolean).join(' ');
  // 20 px icons scale the stroke to 1.75 px (spec §9) rather than the 1.875 px plain scaling gives.
  const style = size === 16 ? undefined : { width: size, height: size, strokeWidth: size === 20 ? 1.4 : undefined };
  return (
    <svg className={cls} viewBox="0 0 16 16" aria-hidden="true" focusable="false" style={style}>
      <path d={d} />
    </svg>
  );
}

// ---------------------------------------------------------------- mode specimens

const BRAILLE_DOTS: [number, number][] = [
  [2, 2], [6, 2], [2, 6], [6, 6], [6, 10], [2, 14], [6, 14], [13, 6], [17, 2], [17, 6], [13, 10], [17, 10], [13, 14],
];

function BrailleSpecimen() {
  return (
    <svg width="22" height="16" viewBox="0 0 22 16" aria-hidden="true" fill="currentColor">
      {BRAILLE_DOTS.map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="1.25" />
      ))}
    </svg>
  );
}

function HalftoneSpecimen() {
  return (
    <svg width="26" height="16" viewBox="0 0 26 16" aria-hidden="true" fill="currentColor">
      <circle cx="2.5" cy="8" r="1" />
      <circle cx="8" cy="8" r="1.8" />
      <circle cx="14.5" cy="8" r="2.6" />
      <circle cx="22" cy="8" r="3.4" />
    </svg>
  );
}

function BlocksSpecimen() {
  return (
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true" fill="currentColor">
      <rect x="1" y="1" width="3.5" height="7" />
      <rect x="1" y="8" width="7" height="7" />
      <rect x="9" y="1" width="3.5" height="7" />
      <rect x="12.5" y="8" width="3.5" height="7" />
      <rect x="17" y="1" width="7" height="7" />
      <rect x="20.5" y="8" width="3.5" height="7" />
    </svg>
  );
}

/** The glyph-ish preview above each mode tile's label. */
export function ModeSpecimen({ mode }: { mode: RenderMode }) {
  switch (mode) {
    case 'shape':
      return <>{'/|\\_'}</>;
    case 'ramp':
      return <>{'.:+#'}</>;
    case 'braille':
      return <BrailleSpecimen />;
    case 'halftone':
      return <HalftoneSpecimen />;
    case 'blocks':
      return <BlocksSpecimen />;
  }
}
