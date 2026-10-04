# Architecture

ASCII Renderer is a static, client-only web app. Every pixel is processed in the browser; there is no server. It builds to plain files (`npm run build` → `dist/`) that can be hosted on GitHub Pages, Vercel or any static host.

## Invariants

1. **One cell geometry everywhere.** The analysis grid, the live preview, PNG/GIF/video export, SVG, HTML and TXT all derive from a single `CellGeometry` (integer `cellW × cellH` device pixels, computed from the selected font's real advance width and line height). `rows = round(cols · srcH/srcW · cellW/cellH)`. Exported raster size is exactly `cols·cellW·scale × rows·cellH·scale`. This is the structural fix for the legacy bug where the PNG renderer measured glyph ink bounds instead of advance/line height and silently squashed the output.
2. **The preview is the export.** The preview canvas is produced by the same compose shader that renders exports, so what you see is what you download.
3. **Live by default.** Parameter changes re-render on the next animation frame; there is no "Render" button. Heavy work (GIF/video encoding) runs off the main thread and is cancellable.
4. **Local only.** Files never leave the device. No runtime network requests other than a file URL the user enters (fonts are bundled).

## Layout

```
src/
  engine/      WebGL2 renderer, glyph atlases, shape-vector math, edge layer, CPU reference implementation
  media/       Decoding inputs: images (EXIF orientation, alpha), GIFs (frame compositing, delays), video (playback + frame-accurate access), camera
  export/      PNG, SVG, TXT, HTML, GIF (worker), MP4/WebM (WebCodecs via Mediabunny), live recording
  app/         Runtime outside React: media lifecycle (controller), engine + render loop (engineHost), shortcuts, settings links
  state/       App store (zustand): source, params, view, playback, export jobs
  ui/          React components implementing the design system
  styles/      Design tokens + global CSS
tests/         Vitest unit tests (geometry, shape-vector math, CPU reference, exporters, state) and Playwright specs (tests/e2e)
dev/           Browser harnesses for the engine, media, export and integration specs
docs/          This file, algorithm notes, design spec
legacy/        The original Python implementation (reference only)
```

## Data flow

```
File / paste / drop / URL / sample / camera
        │
   media/  ──►  FrameSource (ImageBitmap | <video> | GIF frame bitmap) + SourceInfo; Player for clips
        │
   engine.setSource(frame)          engine.setParams(params)  ◄── state store (sliders, modes)
        │
   engine.render(viewport) ── analysis passes (per-cell glyph index + colour) ── compose pass ──► preview <canvas>
        │
   engine.snapshot()  ──►  TXT / SVG / HTML / copy text
   engine.readRaster({scale}) (async readback) ──► PNG worker ;  per frame ──► GIF worker / WebCodecs encoder
```

## Engine

WebGL2 (with a CPU fallback that runs the same reference code). Each analysed frame runs:

1. **Pass 1, lightness.** The source texture (mipmapped) is resampled to the analysis image (`cols·SW × rows·SH`), converted to linear lightness and tone-mapped (levels, brightness, contrast, gamma, invert; transparent pixels are paper: tone is scaled by alpha after tone mapping, ALGORITHM §3). **Pass 1b** averages quadrant colours for colour modes.
2. **Pass 1c, edges** (shape and ramp with `edges` on, ALGORITHM §5b): a difference of Gaussians (`edge-blur`, `edge-dog`) whose Sobel gradients are binned per cell into `| / \ - _` strokes.
3. **Pass 2, cells.** One fragment per cell writes glyph index, tone and colour:
   - `shape`: 6 internal sampling circles + 10 external circles → global and directional contrast → nearest glyph by brute force over the glyph-vector texture (≤ 256 glyphs).
   - `ramp`: mean tone → coverage-sorted charset, with the blue-noise tone dither.
   - `braille`: 2×4 dot means → threshold (ordered / noise / none) → U+2800 + bits.
   - `blocks`: 2×2 quadrants → 16 block elements (colour mode: best two-colour partition).
   - `halftone`: mean tone → dot coverage (drawn analytically in compose).
   With history (GIF / video), every mode keeps its previous state unless the image clearly changes (ALGORITHM §8). Each mode has a uniform-driven program that serves every font and line height, plus one specialised for the current geometry that compiles in the background (`KHR_parallel_shader_compile`), once the geometry has stopped changing for 400 ms, and takes over when ready; `warmup()` compiles all of them ahead of time. Framebuffer completeness is checked once per context, so allocating targets never waits on the GPU process.
4. **Compose** draws the grid at the requested size: each output pixel finds its cell, fetches the glyph index and samples the glyph atlas (glyphs rasterised at the exact device cell size, at their natural baseline). Below zoom 0.75 the preview composes the 1× export offscreen and box-filters it onto the canvas (ALGORITHM §8b), so small text stays legible. With `Viewport.compareWith = 'ramp'` the split's left side is a second analysis in ramp mode with its own cell targets and history; with `transparentBackground` the paper is dropped exactly as in a transparent export.

Readback never stalls the main thread: `readRaster` composes every export tile at call time and reads it back through pixel-pack buffers and a polled fence (rasters over 64 MB in batches, all composed from a copy of the cell texture and the params taken at the call, so edits, new frames or a closed file in between change nothing; a pooled buffer gets fresh storage before each reuse, since Chrome logs a performance warning for every rewrite of a fenced READ buffer and stops reporting WebGL errors after ~32 of them); `probe(col, row)` answers from an asynchronous readback of the cell texture (marked `pending` until the newest frame's arrives); `getTimings()` reports GPU time from `EXT_disjoint_timer_query_webgl2` when available, for frames that ran the analysis (every such result since the last call, `gpuSamples`; view-only redraws are not timed into it). `releaseSource()` frees the source texture and every grid-sized target.

Glyph shape vectors are computed once per (font, charset, cell aspect) by rasterising each glyph large, sampling the same circle layout and normalising (see `docs/ALGORITHM.md`). The CPU reference implementation (pure TypeScript, typed arrays) is what the unit tests check, the GPU path is checked against it cell for cell in the browser tests, and it is the fallback when WebGL2 is unavailable.

## Media

Every loader returns a `LoadedMedia` with `retain()` and `dispose()`: `dispose()` is deferred until every `retain()` has been released (releasing twice is harmless), so an export can keep reading a file the user has already replaced or closed.

- **Images:** `createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none' })` (EXIF orientation honoured), plus a ≤ 512 px `thumbnail` made off the main thread for auto-levels and the alpha check. Transparent pixels are paper: the engine scales tone by alpha after tone mapping (ALGORITHM §3).
- **GIFs:** parsed with `gifuct-js` (loaded with the first GIF), composited by our own compositor (`gif-core.ts`: disposal, transparency, frame offsets; pixel-identical to Chrome's decoder) on demand, with canvas checkpoints bounding seek cost; finished frames are `ImageBitmap`s in an LRU cache that closes them on eviction. Exports read their own frames (`readFrame`) outside that cache. Per-frame delays preserved (0/10 ms delays normalised to 100 ms like browsers do); `loopCount` counts total plays (0 = forever).
- **Video:** `<video>` element for real-time playback (`requestVideoFrameCallback`); the player indexes the clip's real frame timestamps (`Player.frameTimes`) so frame steps visit consecutive frames on variable-rate clips. Mediabunny decodes in order for frame-accurate export, audio passed through or transcoded.
- **Camera:** `openCamera(constraints?, { signal })` returns a live `LoadedVideo` (`live: true`, `durationSec: Infinity`) playing a `getUserMedia` stream; its player only plays and pauses. Disposing it stops the tracks. Denied, insecure-page, missing and busy cameras are `MediaError`s (`camera-blocked`, `camera-unavailable`).

## Export

| Format | How | Exactness |
|---|---|---|
| PNG | `readRaster({scale})` (async readback) → encoded in a worker | `cols·cellW·scale × rows·cellH·scale`, verified by tests |
| TXT | `snapshot().chars` rows joined with `\n` | identical grid |
| SVG | glyph outlines as one `<path>` per colour (default; pre-extracted for every bundled font's whole subset, missing characters kept as text in their cell) or one `<text>` per row with the embedded font; braille / blocks / halftone as shapes | same geometry |
| HTML | glyph modes: a `<pre>` with the bundled font and a per-line baseline strut, coloured spans in Source colour; braille / blocks / halftone: the SVG shapes plus an invisible selectable text layer | same geometry as the 1× PNG |
| GIF | frames read back asynchronously → worker: one global palette (sampled across the whole clip in Source colour), inter-frame deltas (changed rectangle + transparent index, disposal 1), source delays | same geometry |
| MP4 / WebM | frames read back asynchronously and handed to WebCodecs (Mediabunny) as `VideoFrame`s built from the pixels, no canvas; odd sizes padded with paper; audio copied or transcoded (`exportAudioPlan`) | same geometry |
| Camera MP4 / WebM | `startRecording(engine, media, opts)` records in real time with MediaRecorder | same geometry, fixed at the start |

`ExportOptions.targetWidth` (Custom width) renders at the next whole scale and shrinks to the exact width in linear light (area average); the height follows the raster's aspect. Exports yield between frames and check their `AbortSignal` every frame, so the UI stays responsive and Cancel is immediate. `estimateExport` gives every format an approximate size from a ≤ 1 MP sample (and, for motion, a few frame pairs) without rendering the full raster; given a `GifDeltaSampler` (a private engine set up like the export's), a GIF's size comes from real delta frames encoded as the exporter encodes them (`gif-estimate.ts`), with a low–high range when they disagree.

## Wiring (what the app calls, in order)

Checked end to end by `tests/e2e/integration.spec.ts` (`dev/integration.ts`) and, through the real UI, by `tests/e2e/ui-*.spec.ts`. The app's side lives in `src/app/controller.ts` (media lifecycle) and `src/app/engineHost.ts` (engine and render loop).

1. `engine = await createEngine()` once for the app (`engine.backend` is `'webgl2'` or the `'cpu'` fallback); attach `engine.canvas`. Re-render on `webglcontextrestored` on that canvas.
2. `await engine.setParams(params)` before anything that needs geometry (`getGeometry`, exports, estimates), and again on every param change. Settings links (`src/app/permalink.ts`, `#s=<base64url JSON>` of the params that differ from the defaults, sanitised like stored settings) are applied before the first render and on `hashchange`; a link wins over the stored params and the hash is removed afterwards.
3. Per media: `media = await loadMedia(file)` (or `openCamera()` for a live source). The new media is prepared completely off screen before anything on screen changes:
   - levels: stills `measureFrameLevels(await sampleFramesForLevels(media))`; clips the 8-frame sample if it lands within 300 ms, else the first frame's own levels, refined when the sample arrives; a camera its first frame's, measured again once auto-exposure has settled. Auto-levels never run per frame, and a live source is never sampled ahead.
   - first frame: `media.bitmap` for stills; for clips `player = createPlayer(media)` and the frame emitted by `await player.seek(0)`; for a camera the first presented frame after `player.play()`.
4. Commit in one synchronous step: detach the previous player's frame listener (late frames from it are ignored by a presentation token), `engine.setLevels(levels)`, `engine.setSource(frame, { width, height, animated })`, `engine.resetHistory()`, wire `player.onFrame((frame, time) => engine.setSource(frame, info))` (calling `engine.resetHistory()` on any discontinuity: seek, step back, loop wrap), then dispose the previous player and media. An open that becomes stale or fails never touches the engine, so the previous media simply keeps playing.
5. `engine.render(viewport)` on animation frames, only when something changed. The engine is created during start-screen idle time and `engine.warmup()` starts right away (current mode first), so neither the first draw nor the first switch to another mode compiles on the main thread. The status bar averages `engine.getTimings()` (every analysed frame's GPU time when available, else the CPU time of the draw); the cursor probe uses `engine.probe(col, row)` and asks again on a later frame while the answer is `pending`. `engine.snapshot()` feeds TXT / SVG / HTML / copy text; `exportPng / exportGif / exportVideo(engine, …)` render through `readRaster`.
6. An export retains its media for the whole job (`const release = media.retain()` … `release()` in `finally`), and the animated exporters retain it themselves too; a yielded export frame is valid only until the next one is requested. GIF / video render on a separate engine built from a snapshot of the settings, so editing during an encode does not change it; the preview player is paused while it runs and resumes afterwards. A camera's MP4 / WebM is `startRecording(engine, media, opts)` on the preview engine, stopped with `stop()` (the file) or `cancel()`.
7. `exportGif` takes a NETSCAPE repeat count; `media.loopCount` counts total plays, so pass `gifRepeatCount(media.loopCount)`. Check `estimateExport` before offering a format (`supported`, `bytes`, `notes`).
8. Replacing media: `setSource` the new frame first, then `player.dispose()`, then `media.dispose()` right away (it closes the bitmaps / releases the `<video>` or stops the camera once no export retains it). Closing media: detach and dispose the same way, then `engine.releaseSource()` frees the source texture and grid-sized GPU memory while the start screen shows; the next `setSource` reallocates.

## Production build

`npm run build` writes `dist/` with relative URLs (`base: './'`), a `Content-Security-Policy` meta tag (`vite.config.ts`: scripts, styles and workers from the app's own origin only; `connect-src https:` for files the user links to; `mediastream:` for the camera) and `<meta name="referrer" content="no-referrer">`. The dev server has no CSP, because Vite's HMR client needs inline scripts.
