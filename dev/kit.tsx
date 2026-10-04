/**
 * Kit sheet: every src/ui/kit component in its states, laid out like the design board a-states.
 * Hover / focus / drag states are simulated with the board's .is-hover / .is-focus / .is-drag
 * classes; everything else is the live component. Open /dev/kit.html (add ?theme=b for B).
 */
import { StrictMode, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/geist/400.css';
import '@fontsource/geist/500.css';
import '@fontsource/geist/600.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import '@fontsource/geist-mono/600.css';
import '../src/styles/index.css';
import type { CharsetPreset, RenderMode } from '../src/engine/types';
import { Icon, ICON_NAMES } from '../src/ui/icons';
import {
  Button,
  Dialog,
  Disclosure,
  HeroSlider,
  IconButton,
  MenuButton,
  ModeTiles,
  NumberField,
  Section,
  Segmented,
  Select,
  SliderRow,
  SliderTrack,
  SwatchField,
  Switch,
  SwitchRow,
  Tabs,
  TextField,
  TickMeter,
  Tile,
  ToastHost,
  ToastView,
  toast,
} from '../src/ui/kit';
import { ModeSpecimen } from '../src/ui/icons';

if (new URLSearchParams(location.search).get('theme') === 'b') document.documentElement.dataset.theme = 'b';

const noop = () => {};

function S({ children, cap, cls }: { children: ReactNode; cap: string; cls?: string }) {
  return (
    <div className={`spec${cls ? ` ${cls}` : ''}`}>
      {children}
      <small>{cap}</small>
    </div>
  );
}

/** Adds documentation-only state classes / attributes to the nth matching descendant. */
function Sim({ sel = 'button', nth = 0, cls, attr, children }: { sel?: string; nth?: number; cls?: string; attr?: [string, string]; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current?.querySelectorAll(sel)[nth];
    if (cls) el?.classList.add(...cls.split(' '));
    if (attr) el?.setAttribute(...attr);
  }, [sel, nth, cls, attr]);
  return (
    <span ref={ref} style={{ display: 'contents' }}>
      {children}
    </span>
  );
}

const TOKENS = ['g0', 'g1', 'g2', 'g3', 'tx-1', 'tx-2', 'tx-3', 'acc'];

function Tokens() {
  const [vals, setVals] = useState<Record<string, string>>({});
  useLayoutEffect(() => {
    const cs = getComputedStyle(document.documentElement);
    setVals(Object.fromEntries(TOKENS.map((t) => [t, cs.getPropertyValue(`--${t}`).trim().replace('#', '').toUpperCase()])));
  }, []);
  return (
    <div className="toks">
      {TOKENS.map((t) => (
        <div className="tok" key={t}>
          <i style={{ background: `var(--${t})` }} />
          <b>{t}</b>
          {vals[t]}
        </div>
      ))}
    </div>
  );
}

/** A small procedural ring of glyphs for the doc's stage / probe mocks. */
function ring(cols: number, rows: number, cx: number, cy: number, r: number, aspect = 2): string {
  const ramp = " .'`:-~=+*|/\\$@";
  let out = '';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const dx = (x - cx) / aspect;
      const dy = y - cy;
      const d = Math.abs(Math.hypot(dx, dy) - r);
      const v = Math.max(0, 1 - d / (r * 0.45));
      out += ramp[Math.min(ramp.length - 1, Math.floor(v * v * ramp.length))];
    }
    out += '\n';
  }
  return out;
}

function TrackDemo({ p, cls, bi }: { p: number; cls?: string; bi?: boolean }) {
  return (
    <div style={{ width: 160 }}>
      <SliderTrack value={p} min={0} max={100} step={0.1} onChange={noop} bipolar={bi} className={cls} aria-label="demo" />
    </div>
  );
}

function LiveControls() {
  const [cols, setCols] = useState(160);
  const [bri, setBri] = useState(0.04);
  const [con, setCon] = useState(1.2);
  const [inv, setInv] = useState(false);
  const [mode, setMode] = useState<RenderMode>('shape');
  const [color, setColor] = useState<'mono' | 'source' | 'duotone'>('duotone');
  const [ink, setInk] = useState('#e6e4df');
  const [charset, setCharset] = useState<CharsetPreset>('ascii');
  const [tab, setTab] = useState<'adjust' | 'glyphs' | 'color'>('adjust');
  const [dialog, setDialog] = useState(false);
  const signed = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
  return (
    <div className="spec-row" style={{ alignItems: 'flex-start' }}>
      <div className="dockbox">
        <Section title="Mode" aux={<><kbd>M</kbd><em>to cycle</em></>}>
          <ModeTiles value={mode} onChange={setMode} />
          <p className="hint">Matches each cell’s shape, so edges read as lines.</p>
        </Section>
        <Section title="Grid" aux={<><em>rows</em> 45 <em>auto · cell</em> 8 × 16</>}>
          <HeroSlider label="Columns" unit="col" value={cols} min={40} max={400} step={1} defaultValue={160} onChange={setCols} majors={[40, 100, 200, 300, 400]} minorStep={10} />
        </Section>
        <Section title="Tone" action={<IconButton icon="reset" label="Reset tone" size="sm" onClick={() => (setBri(0), setCon(1))} />}>
          <div className="rows">
            <SliderRow label="Brightness" value={bri} min={-0.5} max={0.5} step={0.01} defaultValue={0} bipolar format={signed} onChange={setBri} />
            <SliderRow label="Contrast" value={con} min={0.5} max={2} step={0.01} defaultValue={1} format={(v) => v.toFixed(2)} onChange={setCon} />
          </div>
          <SwitchRow label="Invert" kbd="I" checked={inv} onChange={setInv} />
        </Section>
        <Section title="Glyphs" aux={<>95 <em>glyphs</em></>}>
          <Select
            label="Character set"
            value={charset}
            aux="printable"
            onChange={setCharset}
            options={[
              { value: 'ascii', label: 'Full ASCII', aux: '95' },
              { value: 'minimal', label: 'Minimal', aux: '10' },
              { value: 'dense', label: 'Dense', aux: '160' },
              { value: 'lines', label: 'Lines', aux: '10' },
              { value: 'custom', label: 'Custom…', aux: 'type your own', separatorBefore: true },
            ]}
          />
        </Section>
        <Section title="Color" aux={<><kbd>D</kbd><em>duotone</em></>}>
          <Segmented full label="Color mode" value={color} onChange={setColor} options={[{ value: 'mono', label: 'Mono' }, { value: 'source', label: 'Source' }, { value: 'duotone', label: 'Duotone' }]} />
          <div className="swatches">
            <SwatchField label="Shadow" value="#5c5953" onChange={noop} />
            <SwatchField label="Ink" value={ink} onChange={setInk} />
            <SwatchField label="Paper" value="#0b0b0c" onChange={noop} />
          </div>
        </Section>
        <Disclosure title="Advanced" summary="Dither, font, cell, line height">
          <p className="hint" style={{ marginTop: 0 }}>Advanced controls live here.</p>
        </Disclosure>
      </div>
      <div className="live">
        <div className="dockbox" style={{ padding: 0 }}>
          <Tabs label="Panel" value={tab} onChange={setTab} tabs={[{ id: 'adjust', label: 'Adjust' }, { id: 'glyphs', label: 'Glyphs' }, { id: 'color', label: 'Color' }]} />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <MenuButton
            label="Presets"
            items={[
              { heading: 'Built-in' },
              { id: 'crisp', label: 'Crisp lines', onSelect: noop },
              { id: 'soft', label: 'Soft photo', onSelect: noop },
              { id: 'braille', label: 'Braille dots', onSelect: noop },
              'separator',
              { id: 'save', label: 'Save current…', onSelect: noop },
            ]}
          />
          <Button variant="ghost" size="sm" icon="reset">
            Reset all
          </Button>
          <IconButton icon="keyboard" label="Shortcuts" shortcut="?" onClick={() => setDialog(true)} />
        </div>
        <div style={{ marginTop: 12 }}>
          <TextField icon="link" placeholder="Paste an image or video URL" aria-label="Image or video URL" action={<Button size="sm">Load</Button>} />
        </div>
        <label className="flabel" htmlFor="fn">File name</label>
        <TextField id="fn" defaultValue="torus_ascii@2x" suffix=".png" />
        <div className="prog" style={{ marginTop: 16 }}>
          <div className="ln"><span>Encoding in a worker. Keep editing.</span><span className="pc">62%</span></div>
          <TickMeter value={0.62} label="Encoding progress" />
          <div className="ln"><span className="meta">Frame 41 / 66 · 00:02 left</span><span className="meta">WebCodecs · H.264</span></div>
        </div>
        <div className="prog" style={{ marginTop: 16 }}>
          <div className="ln"><span>Decoding…</span></div>
          <TickMeter value={null} label="Decoding" />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <Button size="sm" onClick={() => toast({ kind: 'success', title: 'Saved torus_ascii@2x.png', body: '2560 × 1440 px · 1.4 MB', trailing: { label: 'Undo', onClick: noop } })}>
            Toast
          </Button>
          <Button size="sm" onClick={() => toast({ kind: 'error', title: 'Couldn’t decode clip.mov', body: 'Re-encode it as H.264 or VP9.', actions: [{ label: 'Try again', onClick: noop }] })}>
            Error toast
          </Button>
        </div>
      </div>
      <Dialog open={dialog} onClose={() => setDialog(false)} title="Keyboard shortcuts">
        <p className="hint" style={{ marginTop: 0 }}>The Shortcuts sheet renders the shortcut registry here.</p>
      </Dialog>
    </div>
  );
}

function KitSheet() {
  const variant = document.documentElement.dataset.theme === 'b' ? 'B · Carbon / Volt' : 'A · Graphite / Signal';
  const art = ring(150, 25, 75, 12.5, 9);
  const probeArt = ring(60, 9, 30, 9, 7);
  return (
    <div className="sb">
      <header className="sb-h">
        <div>
          <a className="wm" href="#" aria-label="ASCII Renderer home">
            <span className="wm-a">ASCII</span>
            <span className="wm-b">Renderer</span>
          </a>
          <h1>Components and states</h1>
          <p>
            Variant {variant}. Every state an engineer needs, drawn with the same tokens and classes as the screens. Interaction states are simulated with
            .is-hover / .is-focus / .is-drag classes for documentation only.
          </p>
        </div>
        <Tokens />
      </header>
      <div className="grid2">
        <section className="card span2">
          <h2>
            Buttons <span>32 px tall, 4 px radius, one primary per screen</span>
          </h2>
          <div className="spec-row">
            <S cap="primary"><Button variant="primary" icon="export" kbd="⌘E">Export</Button></S>
            <S cap="hover"><Button variant="primary" icon="export" kbd="⌘E" className="is-hover">Export</Button></S>
            <S cap="focus-visible"><Button variant="primary" icon="export" kbd="⌘E" className="is-focus">Export</Button></S>
            <S cap="disabled"><Button variant="primary" icon="download" disabled>Save MP4</Button></S>
            <S cap="secondary"><Button icon="folder" kbd="⌘O">Open</Button></S>
            <S cap="hover"><Button icon="folder" kbd="⌘O" className="is-hover">Open</Button></S>
            <S cap="pressed"><Button icon="folder" kbd="⌘O" className="is-active">Open</Button></S>
            <S cap="ghost"><Button variant="ghost" icon="reset">Reset all</Button></S>
            <S cap="ghost hover"><Button variant="ghost" icon="reset" className="is-hover">Reset all</Button></S>
            <S cap="icon"><IconButton icon="undo" label="Undo" shortcut="⌘Z" /></S>
            <S cap="icon on"><IconButton icon="grid" label="Rulers" shortcut="R" variant="secondary" pressed /></S>
            <S cap="icon focus"><IconButton icon="redo" label="Redo" shortcut="⇧⌘Z" className="is-focus" /></S>
          </div>
        </section>

        <section className="card">
          <h2>
            Segmented control <span>32 px, active = 2 px accent underline</span>
          </h2>
          <div className="spec-row">
            <S cap="selected = g3 + 2px accent underline"><ViewSeg /></S>
            <S cap="hover"><Sim nth={1} cls="is-hover"><ViewSeg /></Sim></S>
            <S cap="focus-visible (inset ring)"><Sim nth={1} cls="is-focus"><ViewSeg /></Sim></S>
            <S cap="mono values">
              <Segmented variant="mono" label="Playback speed" value={1} onChange={noop} options={[{ value: 0.5, label: '0.5×' }, { value: 1, label: '1×' }, { value: 2, label: '2×' }]} />
            </S>
          </div>
        </section>

        <section className="card">
          <h2>
            Mode tiles <span>radiogroup, M cycles</span>
          </h2>
          <div className="spec-row">
            <S cap="selected"><Tile checked specimen={<ModeSpecimen mode="shape" />} label="Shape" style={{ width: 64 }} /></S>
            <S cap="hover"><Tile checked={false} specimen={<ModeSpecimen mode="ramp" />} label="Ramp" className="is-hover" style={{ width: 64 }} /></S>
            <S cap="focus-visible"><Tile checked={false} specimen={<ModeSpecimen mode="ramp" />} label="Ramp" className="is-focus" style={{ width: 64 }} /></S>
            <S cap="rest"><Tile checked={false} specimen={<ModeSpecimen mode="ramp" />} label="Ramp" style={{ width: 64 }} /></S>
          </div>
        </section>

        <section className="card span2">
          <h2>
            Slider <span>ticked track + fill + neutral thumb; accent only while focused or dragged</span>
          </h2>
          <div className="spec-row">
            <S cap="rest: neutral thumb, grey fill"><TrackDemo p={46.7} /></S>
            <S cap="hover: thumb grows to 20px"><TrackDemo p={46.7} cls="is-hover" /></S>
            <S cap="dragging: accent thumb + fill"><TrackDemo p={46.7} cls="is-drag" /></S>
            <S cap="focus-visible: accent ring"><TrackDemo p={46.7} cls="is-focus" /></S>
            <S cap="bipolar: fills out from the 0 detent"><TrackDemo p={62} bi /></S>
            <S cap="disabled (mode does not use it)">
              <div style={{ width: 330 }}>
                <SliderRow label="Edge sharpness" value={2.2} min={1} max={4} step={0.05} format={(v) => v.toFixed(2)} onChange={noop} disabled />
              </div>
            </S>
          </div>
          <p className="note">
            <b>Keyboard:</b> ← → step 1% of range, Shift ×10, Home / End to min / max, Backspace resets to default. <b>Pointer:</b> click the track to jump,
            drag the thumb, or drag the label / value field horizontally to scrub (Shift = fine). The preview re-renders on every input event.
          </p>
        </section>

        <section className="card">
          <h2>
            Value field <span>32 px, tabular mono, right-aligned</span>
          </h2>
          <div className="spec-row">
            <S cap="rest"><div style={{ width: 64 }}><NumberField value={1.2} min={0.5} max={2} step={0.01} format={(v) => v.toFixed(2)} onChange={noop} aria-label="demo" /></div></S>
            <S cap="hover: ew-resize, drag to scrub"><div style={{ width: 64 }}><NumberField value={1.2} min={0.5} max={2} step={0.01} format={(v) => v.toFixed(2)} onChange={noop} className="is-hover" aria-label="demo" /></div></S>
            <S cap="editing (click or Enter)"><div style={{ width: 64 }}><NumberField value={1.2} min={0.5} max={2} step={0.01} format={(v) => v.toFixed(2)} onChange={noop} className="is-focus" aria-label="demo" /></div></S>
            <S cap="hero value (Columns)"><NumberField big value={160} min={40} max={400} step={1} onChange={noop} aria-label="demo" /></S>
          </div>
        </section>

        <section className="card">
          <h2>
            Switch <span>whole 32 px row is the label</span>
          </h2>
          <div className="spec-row">
            <S cap="off"><Switch checked={false} onChange={noop} aria-label="demo" /></S>
            <S cap="on"><Switch checked onChange={noop} aria-label="demo" /></S>
            <S cap="focus-visible"><Switch checked onChange={noop} className="is-focus" aria-label="demo" /></S>
            <S cap="disabled"><Switch checked={false} onChange={noop} disabled aria-label="demo" /></S>
          </div>
        </section>

        <section className="card">
          <h2>
            Select · listbox <span>Glyphs → character set</span>
          </h2>
          <div className="spec-row">
            <S cap="trigger expanded, menu 4 px below · 32 px options">
              <div style={{ display: 'grid', gap: 4 }}>
                <Sim attr={['aria-expanded', 'true']}>
                  <div style={{ width: 240 }}>
                    <Select label="Character set" value="ascii" aux="printable" onChange={noop} options={[{ value: 'ascii', label: 'Full ASCII' }]} />
                  </div>
                </Sim>
                <div className="menu static" role="listbox" aria-label="Character set">
                  {[
                    ['Full ASCII', '95', true],
                    ['Minimal', '10', false],
                    ['Blocks', '16', false],
                    ['Letters and digits', '62', false],
                  ].map(([n, c, on]) => (
                    <div key={n as string} role="option" aria-selected={on as boolean}>
                      <span className="ck">{on && <Icon name="check" />}</span>
                      <span className="nm">{n}</span>
                      <small>{c}</small>
                    </div>
                  ))}
                  <hr />
                  <div role="option" aria-selected={false}>
                    <span className="ck" />
                    <span className="nm">Custom…</span>
                    <small>type your own</small>
                  </div>
                </div>
              </div>
            </S>
            <p className="note" style={{ margin: 0, flex: 1, minWidth: 200 }}>
              <b>Presets</b> Full ASCII (95), Minimal (10: space . : - = + * # % @), Blocks (16 quadrants), Letters and digits (62), Custom. Custom opens an
              inline text field; glyphs are de-duplicated and the count updates live.
            </p>
          </div>
        </section>

        <section className="card">
          <h2>
            Swatch · colour popover <span>Shadow / Ink / Paper</span>
          </h2>
          <div className="spec-row">
            <S cap="swatches">
              <div className="swatches" style={{ width: 272, margin: 0 }}>
                <SwatchField label="Shadow" value="#5c5953" onChange={noop} />
                <SwatchField label="Ink" value="#e6e4df" onChange={noop} />
                <SwatchField label="Paper" value="#0b0b0c" onChange={noop} />
              </div>
            </S>
            <S cap="popover · hex field">
              <div className="pop" role="group" aria-label="Ink colour">
                <div className="pk" />
                <div className="hue" />
                <TextField prefix="#" defaultValue="E6E4DF" aria-label="Hex" suffix="100%" />
              </div>
            </S>
          </div>
        </section>

        <section className="card span2">
          <h2>Drop, drag-over and loading</h2>
          <div className="spec-row">
            <S cap="drop zone · rest" cls="half">
              <div className="mini-dz"><div><div className="t">Drop an image, GIF or video</div><div className="s">PNG · JPG · GIF · MP4 · WEBM</div></div></div>
            </S>
            <S cap="drop zone · drag-over (accent edge)" cls="half">
              <div className="mini-dz over"><div><div className="t">Release to open sunset.gif</div><div className="s">GIF · 480 × 270 · 64 frames</div></div></div>
            </S>
            <S cap="editor · drag-over the stage" cls="half">
              <div className="stage-over">
                <pre>{art}</pre>
                <div className="drop-ov" style={{ animation: 'none' }}>
                  <div className="pill"><Icon name="upload" />Drop to replace torus.png</div>
                </div>
              </div>
            </S>
            <S cap="video · buffering" cls="half">
              <div className="buf">
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--tx-2)', marginBottom: 8 }}>
                  <span>Decoding frames…</span>
                  <span className="mono" style={{ color: 'var(--tx-1)' }}>Cached 120 / 192</span>
                </div>
                <div className="strip" style={{ background: 'var(--paper)' }}>
                  <span className="cached" style={{ width: '62.5%' }} />
                  <span className="ph" style={{ left: '30%', top: -4 }} />
                </div>
                <p className="note" style={{ marginTop: 8 }}>Playback starts at once; frames beyond the cache render on demand.</p>
              </div>
            </S>
          </div>
        </section>

        <section className="card span2">
          <h2>
            Toasts <span>bottom-centre of the stage, 380 px, auto-dismiss 5 s except errors</span>
          </h2>
          <div className="spec-row" style={{ alignItems: 'flex-start' }}>
            <S cap="error · unsupported file">
              <ToastView kind="error" icon="file-x" title="That file type isn’t supported" body="notes.pdf is a PDF. Open a PNG, JPG, WebP, AVIF, GIF, MP4, WebM or MOV." onDismiss={noop} />
            </S>
            <S cap="error · decode failed">
              <ToastView
                kind="error"
                title="Couldn’t decode clip.mov"
                body="The browser couldn’t decode its HEVC video track. Re-encode it as H.264 or VP9, then open it again."
                actions={[{ label: 'Try again', onClick: noop }, { label: 'Learn why', onClick: noop }]}
                onDismiss={noop}
              />
            </S>
            <S cap="success">
              <ToastView kind="success" title="Saved torus_ascii@2x.png" body="2560 × 1440 px · 1.4 MB · matches source 16:9" trailing={{ label: 'Undo', onClick: noop }} />
            </S>
            <S cap="info · copy text">
              <ToastView kind="info" icon="copy" title="Copied 45 lines of text" body="160 columns. Paste into any monospace editor." />
            </S>
          </div>
        </section>

        <section className="card span2">
          <h2>
            Tooltip · icons <span>16 px grid, 1.5 px stroke; tooltips show the shortcut</span>
          </h2>
          <div className="spec-row">
            <S cap="tooltip">
              <div className="tip static">Undo<kbd>⌘Z</kbd></div>
            </S>
            <S cap={`${ICON_NAMES.length} icons`} cls="w">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, color: 'var(--tx-2)' }}>
                {ICON_NAMES.map((n) => (
                  <span key={n} title={n}><Icon name={n} /></span>
                ))}
                {(['shape', 'ramp', 'braille', 'halftone', 'blocks'] as const).map((m) => (
                  <span key={m} className="mono" style={{ display: 'flex', alignItems: 'center', height: 16 }}><ModeSpecimen mode={m} /></span>
                ))}
              </div>
            </S>
          </div>
        </section>

        <section className="card">
          <h2>Cell probe</h2>
          <div className="spec-row">
            <S cap="hover only · sits beside the cell on the emptier side, never over it · hidden while a slider drags" cls="w">
              <div className="probe-demo">
                <pre>{probeArt}</pre>
                <div className="probe" style={{ '--cw': '6px', '--lh': '12px', left: 10 + 6 * 26, top: 8 + 12 * 4 } as CSSProperties} />
                <div className="tag" style={{ left: 10 + 6 * 26 - 12 - 150, top: 8 + 12 * 4 - 6, width: 150 }}>
                  <span>C<b>093</b> R<b>22</b></span>
                  <span className="gl">d</span>
                  <span>L <b>0.73</b></span>
                </div>
              </div>
            </S>
          </div>
        </section>

        <section className="card">
          <h2>
            Phone sheet heights <span>drag the grabber; snaps to three detents</span>
          </h2>
          <div className="phones">
            {[
              ['Peek', '112 px', 'preview ≥ 40% vh', 76, 2],
              ['Half', '47% (default)', 'tabs: Adjust · Glyphs · Color', '47%', 6],
              ['Full', '88%', 'export always opens here', '88%', 14],
            ].map(([name, size, note, h, n]) => (
              <div key={name as string}>
                <div className="ph-mini">
                  <div className="tb" />
                  <div className="ms" />
                  <div className="pv">preview</div>
                  <div className="sh2" style={{ height: h as number | string }}>
                    {Array.from({ length: n as number }, (_, k) => (
                      <i key={k} style={{ top: 16 + 14 * k, width: k === 0 ? '60%' : undefined }} />
                    ))}
                  </div>
                </div>
                <div className="ph-cap"><b>{name}</b> · {size}<br />{note}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="card span2">
          <h2>
            Live controls <span>wired kit components: drag, scrub, type, use the keyboard</span>
          </h2>
          <LiveControls />
        </section>
      </div>
      <ToastHost placement="window" />
    </div>
  );
}

function ViewSeg() {
  return (
    <Segmented
      kind="toggle"
      label="View"
      value="output"
      onChange={noop}
      options={[{ value: 'output', label: 'Output' }, { value: 'split', label: 'Split' }, { value: 'source', label: 'Source' }]}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <KitSheet />
  </StrictMode>,
);
