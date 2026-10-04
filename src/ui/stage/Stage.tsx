/**
 * The preview (design spec §4.2): the engine's canvas in the art area of the viewport, with the
 * frame, rulers, probe, split handle, export dimension lines and caption as DOM / 2D-canvas
 * overlays positioned from the engine's own layout (engineHost.useStageLayout).
 *
 * Desktop: the art area leaves 28 px left and 24 px top for rulers or dimension lines and 26 px
 * below for the caption, so the grid plus its furniture is centred. Phone: a full-width 16:9 box,
 * no rulers or caption, and a one-line readout under it for stills (a clip's transport goes there).
 *
 * Nothing here re-renders on a frame: the render loop lives in engineHost, input in useStageInput.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { setStageBox } from '../../app/engineHost';
import { useRuntime } from '../../app/runtime';
import { selectIsAnimated, selectIsLive, useStore } from '../../state/store';
import { cx, PHONE_QUERY, SHORT_QUERY, useMediaQuery } from '../kit';
import { Caption, ExportDims } from './Caption';
import { formatMs } from './format';
import type { StageBox } from './layout';
import { ProbeOutline, ProbeTag } from './Probe';
import { Rulers } from './Rulers';
import { GridFrame, SplitOverlay, TransparencyChecker } from './SplitOverlay';
import { useStageInput } from './useStageInput';
import './stage.css';

const FIT_PAD = { desktop: 32, short: 8, phone: 0 };

export default function Stage() {
  const phone = useMediaQuery(PHONE_QUERY);
  const short = useMediaQuery(SHORT_QUERY);
  const vpRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const pannable = useStore((s) => s.view.zoom !== 'fit');
  // A clip's transport takes the readout's place on phones, so the timeline stays above the sheet.
  // A live camera has no timeline (only a play / pause row), so it keeps the readout in that space.
  const readout = useStore((s) => !selectIsAnimated(s) || selectIsLive(s));

  useEngineCanvas(canvasHostRef);
  useStageBox(vpRef, areaRef, phone ? FIT_PAD.phone : short ? FIT_PAD.short : FIT_PAD.desktop);
  useStageInput(vpRef);

  return (
    <>
      <div ref={vpRef} className={cx('vp', pannable && 'pannable')}>
        <div ref={areaRef} className="va">
          <TransparencyChecker />
          <div ref={canvasHostRef} className="va-canvas" />
          <GridFrame />
          <SplitOverlay />
          <ProbeOutline />
        </div>
        {!phone && (
          <>
            <Rulers />
            <ExportDims />
            <Caption />
          </>
        )}
        <ProbeTag />
      </div>
      {phone && readout && <PhoneReadout />}
    </>
  );
}

/**
 * Mounts the engine's canvas in its host in the art area (above the transparency checker, below
 * the overlays) and keeps its accessible name current.
 */
function useEngineCanvas(hostRef: RefObject<HTMLDivElement | null>) {
  const engine = useRuntime((r) => r.engine);
  const name = useStore((s) => s.media.info?.name);
  const cols = useStore((s) => s.stats.cols);
  const rows = useStore((s) => s.stats.rows);

  useEffect(() => {
    const host = hostRef.current;
    if (!engine || !host) return;
    const canvas = engine.canvas;
    canvas.classList.add('art-canvas');
    canvas.setAttribute('role', 'img');
    host.append(canvas);
    return () => canvas.remove();
  }, [engine, hostRef]);

  useEffect(() => {
    engine?.canvas.setAttribute('aria-label', name ? `ASCII render of ${name}, ${cols} by ${rows} cells` : 'ASCII render');
  }, [engine, name, cols, rows]);
}

/** Measures the viewport and its art area (ResizeObserver + DPR changes) for the render loop. */
function useStageBox(vpRef: RefObject<HTMLDivElement | null>, areaRef: RefObject<HTMLDivElement | null>, pad: number) {
  useLayoutEffect(() => {
    const vp = vpRef.current;
    const area = areaRef.current;
    if (!vp || !area) return;
    const measure = () => {
      const box: StageBox = {
        width: vp.clientWidth,
        height: vp.clientHeight,
        area: { x: area.offsetLeft, y: area.offsetTop, width: area.clientWidth, height: area.clientHeight },
        dpr: window.devicePixelRatio || 1,
        pad,
      };
      setStageBox(box.area.width > 0 && box.area.height > 0 ? box : null);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(vp);
    ro.observe(area);
    // Moving the window to another display (or browser zoom) changes the DPR without a resize of the element.
    let mql = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onDpr = () => {
      mql.removeEventListener('change', onDpr);
      mql = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mql.addEventListener('change', onDpr);
      measure();
    };
    mql.addEventListener('change', onDpr);
    measure();
    return () => {
      ro.disconnect();
      mql.removeEventListener('change', onDpr);
      setStageBox(null);
    };
  }, [vpRef, areaRef, pad]);
}

/** Phone: "Grid 160 × 45 · Render 2.4 ms · FPS 60" under the preview. */
function PhoneReadout() {
  const cols = useStore((s) => s.stats.cols);
  const rows = useStore((s) => s.stats.rows);
  const ms = useStore((s) => s.stats.ms);
  const fps = useStore((s) => s.stats.fps);
  return (
    <div className="pstat">
      <span>
        Grid <b>{cols} × {rows}</b>
      </span>
      <span>
        Render <b>{cols ? `${formatMs(ms)} ms` : '–'}</b>
      </span>
      <span>
        FPS <b>{fps || '–'}</b>
      </span>
    </div>
  );
}
