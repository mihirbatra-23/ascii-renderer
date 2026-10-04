/**
 * The start screen's drop zone (spec §4.1): ruler strip in grid units, dotted field, and the
 * ways to open something: Choose file (primary), Paste, Camera, or a URL (field + Load). The whole window is
 * the drop target (app/hooks.ts); this only mirrors `ui.dragOver` with the accent edge and
 * "Release to open".
 *
 * While the first file loads, the start screen stays and says so here ("Opening torus.png…"
 * with an indeterminate meter); a file that fails leaves the user exactly where they were.
 */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { cameraAvailable, openCamera } from '../../app/controller';
import { useStore, type DragInfo } from '../../state/store';
import { Icon } from '../icons';
import { Button, TextField } from '../kit';
import { FORMATS } from './samples';
import { openUrl, pasteFromClipboard, pickAndOpen } from './openers';
import { useShortcutLabel } from './useShortcutLabel';

export default function DropZone() {
  const drag = useStore((s) => (s.ui.dragOver?.supported ? s.ui.dragOver : null));
  const opening = useStore((s) => (s.media.status === 'loading' ? s.media.pending : undefined));
  return (
    <section className={drag ? 'dz over' : 'dz'} aria-label="Open a file" aria-busy={!!opening}>
      <Ruler />
      {opening && <div className="dz-load" aria-hidden="true" />}
      <div className="dz-in">
        <span className="dz-ic">
          <Icon name="upload" />
        </span>
        {drag ? (
          <h2>Release to open {dragTarget(drag)}</h2>
        ) : opening ? (
          <h2 className="dz-opening">Opening {opening}…</h2>
        ) : (
          <h2>
            <span className="desk-only">Drop</span>
            <span className="phone-only">Open</span> an image, GIF or video
          </h2>
        )}
        <Actions />
        <p className="fmts-l">
          {FORMATS.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </p>
      </div>
    </section>
  );
}

const KIND_NOUN = { image: 'the image', animation: 'the GIF', video: 'the video' } as const;

function dragTarget({ name, kind }: DragInfo): string {
  return name ?? (kind ? KIND_NOUN[kind] : 'the file');
}

function Actions() {
  const openCombo = useShortcutLabel('file.open', 'mod+o');
  const pasteCombo = useShortcutLabel('file.paste', 'mod+v');
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const load = async (value: string) => {
    abort.current?.abort();
    const ctl = (abort.current = new AbortController());
    setLoading(true);
    try {
      await openUrl(value, ctl.signal);
    } finally {
      if (abort.current === ctl) setLoading(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) input.current?.focus();
    else if (!loading) void load(url);
  };

  return (
    <div className="dz-acts">
      <Button variant="primary" icon="folder" kbd={openCombo} onClick={pickAndOpen}>
        Choose file
      </Button>
      <Button
        icon="paste"
        kbd={pasteCombo}
        onClick={() =>
          void pasteFromClipboard((link) => {
            setUrl(link);
            void load(link);
          })
        }
      >
        Paste
      </Button>
      {cameraAvailable() && (
        <Button icon="camera" onClick={() => void openCamera()}>
          Camera
        </Button>
      )}
      <span className="or" aria-hidden="true">
        or
      </span>
      {/* noValidate: a bad address gets the app's explanation, not the browser's bubble. Load is
          disabled while the field is empty, so it never invites a click that does nothing. */}
      <form className="dz-url" noValidate onSubmit={onSubmit}>
        <TextField
          type="url"
          inputMode="url"
          ref={input}
          icon="link"
          aria-label="Image or video URL"
          placeholder="Image or video URL"
          value={url}
          readOnly={loading}
          onChange={(e) => setUrl(e.target.value)}
        />
        <Button type="submit" disabled={loading || !url.trim()} aria-busy={loading}>
          {loading ? 'Loading…' : 'Load'}
        </Button>
      </form>
    </div>
  );
}

const TICK_PX = 64;
const FIRST_PX = 12;
// A numeral needs about this much room past its tick; partial labels at the edge are dropped.
const LABEL_PX = 28;

/** One numeral every 10 columns (6.4 px per column), as many as fit the zone's width. */
function Ruler() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const count = Math.max(0, Math.floor((width - FIRST_PX - LABEL_PX) / TICK_PX) + 1);
  return (
    <div ref={ref} className="dz-r desk-only" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} style={{ left: FIRST_PX + i * TICK_PX }}>
          {i * 10}
        </span>
      ))}
    </div>
  );
}
