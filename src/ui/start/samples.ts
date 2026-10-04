/**
 * The bundled samples (public/samples/) and the app facts the start screen shows.
 * Paths are relative to the deploy base, so the static build works under any sub-path.
 */
import type { RenderParams } from '../../engine/types';
import type { IconName } from '../icons';
import { version } from '../../../package.json';

export const APP_VERSION = version;
export const REPO_URL = 'https://github.com/mihirbatra-23/ascii-renderer';

export interface Sample {
  /** Shortcut key on the start screen ('1'–'3'). */
  key: string;
  name: string;
  url: string;
  kind: 'image' | 'video';
  icon: IconName;
  /**
   * The sample's look (mode and tone, as on the design boards): the thumbnail is drawn with it
   * and opening the sample applies it, so the editor shows what the tile promised.
   */
  look: Partial<RenderParams> & Pick<RenderParams, 'mode'>;
  /** A small copy the tile is rendered from (videos: the poster frame), made by scripts/make_samples.py. */
  thumbUrl: string;
  meta: string;
}

/**
 * A look sets every parameter that shapes the glyphs (not colour or columns, which stay the user's),
 * so the editor matches its tile whatever was open before.
 */
const STILL_LOOK = {
  mode: 'shape',
  charsetPreset: 'ascii',
  brightness: 0.04,
  contrast: 1.2,
  gamma: 0.8,
  invert: false,
  shapeSharpness: 2,
  edgeSharpness: 2.2,
  dither: 0,
  edges: false,
} as const;

/**
 * The video's look: Ramp over a short, evenly stepped glyph set. Full printable ASCII has tone steps
 * smaller than codec noise, so on video its letters re-shuffle every frame ("boil"); ten
 * glyphs keep flat areas still and let the rings read.
 */
const VIDEO_LOOK = {
  mode: 'ramp',
  charsetPreset: 'minimal',
  brightness: 0,
  contrast: 1.15,
  gamma: 0.85,
  invert: false,
  dither: 0,
  edges: false,
} as const;

const base = import.meta.env.BASE_URL;

export const SAMPLES: readonly Sample[] = [
  {
    key: '1',
    name: 'torus.png',
    url: `${base}samples/torus.png`,
    thumbUrl: `${base}samples/thumbs/torus.png`,
    kind: 'image',
    icon: 'image',
    look: STILL_LOOK,
    meta: 'Shape · 1280 × 720',
  },
  {
    key: '2',
    name: 'interference_loop.mp4',
    url: `${base}samples/interference_loop.mp4`,
    // Frame 34 of 96, as on the board.
    thumbUrl: `${base}samples/thumbs/interference_loop.jpg`,
    kind: 'video',
    icon: 'film',
    look: VIDEO_LOOK,
    meta: 'Ramp · 4.0 s',
  },
  {
    key: '3',
    name: 'planet.png',
    url: `${base}samples/planet.png`,
    thumbUrl: `${base}samples/thumbs/planet.png`,
    kind: 'image',
    icon: 'image',
    look: STILL_LOOK,
    meta: 'Shape · 1280 × 720',
  },
];

/**
 * What loadMedia can decode, shown under the drop zone actions and named in the unsupported-type
 * error (one list, so the two never disagree).
 */
export const FORMATS = ['PNG', 'JPG', 'WEBP', 'AVIF', 'GIF', 'SVG', 'MP4', 'WEBM', 'MOV'] as const;
