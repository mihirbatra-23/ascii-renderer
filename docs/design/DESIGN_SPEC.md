# ASCII Renderer: design spec

This spec describes the app's interface: one layout, one component set and one theme (Graphite / Signal). The screenshots in this folder are the reference screens; this document gives the rules behind them.

- **Tokens:** `tokens.css`, all on `:root`.
- **Reference screens (1440 × 900):** `a-start.png`, `a-editor.png`, `a-editor-video.png`, `a-export.png` and `a-compare.png`. `a-editor-phone.png` shows the 390 × 844 layout.

---

## 1. Design direction

The app is designed like a precision instrument for text-mode art: graphite chrome, hairline rules, rulers in grid units, tabular mono readouts and a single signal accent. It aims to feel futuristic through exactness rather than effects, so there are no gradients, glows or glass, and no `backdrop-filter` over the live canvas.

Principles that hold across every screen:

- Tracked capitals only for section heads, ruler and axis labels, and status keys.
- A 10 px type floor; control labels are 13 px.
- One primary action per screen.
- Sliders have a filled track, a centre detent for bipolar values, a 32 px hit area and a focus ring.
- Hit targets are at least 32 px.
- One accent hue; status indicators stay neutral.
- Every ASCII render shown in the UI is real engine output.
- Overlays are transform-only layers, and rulers are drawn on a 2D canvas.
- Fonts are self-hosted.

### Theme

The app ships one theme, Graphite / Signal: cool graphite chrome (`--g1 #0F1011`, `--tx-2 #A6AAB2`), an international orange accent (`#FF6A2B`, text on accent `#140A05`) and warm paper-white render ink (`#E6E4DF` on `#0B0B0C`). Cool chrome with warm ink makes the artwork read as a material rather than as more UI text.

---

## 2. Layout grid and breakpoints

### Desktop shell (CSS grid on `.app`)

```
rows:    48px (top bar) | 1fr (stage + dock) | 28px (status bar)
columns: 1fr (stage)    | var(--w-dock)  336px, 304px at <= 1280px
```

- **Top bar** (48 px, `--g1`, bottom hairline), from left to right:
  - Back to start screen (ghost arrow icon button; it opens the close confirmation below);
  - wordmark;
  - a 1 × 20 px divider;
  - the source chip (icon, filename, mono meta);
  - flexible space;
  - undo / redo (ghost icon buttons);
  - a divider;
  - GitHub (ghost, GitHub mark and label);
  - Open ⌘O (secondary split button: the main part opens the file picker; its chevron, "More ways to open", lists Choose file…, Paste and Camera);
  - Export ⌘E (primary).

  Padding is 8 px left (so the back arrow's glyph lands on x = 16), 12 px right, and the gap is 12 px.

  Back, the wordmark and the phone More sheet's Close file / Stop camera all open one confirmation: a 400 px alert dialog with no header, the title "Close {file name}?" (camera: "Stop the camera?"), the line "Your settings are kept." and a footer with Cancel and Close file (camera: Stop camera). Focus starts on Cancel; Enter confirms from anywhere else in the dialog, Esc cancels and returns focus to Back.
- **Stage header** (48 px, `--g0`): the view segmented control (Output / Split / Source), in Split the compare menu ("vs Original ▾" / "vs Ramp ▾"), and an optional context label on the left; the Rulers toggle, zoom group (− 75% +) and Fit on the right. It is the same height as the dock header, so the two hairlines line up. It follows the stage's own width (container queries), not the window's: at ≤ 720 px the context label hides; at ≤ 500 px (≤ 640 px while Split shows its compare menu) the view switch and Fit become icon-only, keeping their names as labels; at ≤ 440 px the compare menu shows only "vs ▾". The "Ramp render" choice is disabled, with the reason under it, while the output is itself Ramp without contour lines (the split then shows the original).
- **Stage viewport:** the frame is centred both ways. The frame reserves 28 px on the left and 24 px on top for the rulers or dimension lines, and has a 10 px gap before the caption.
- **Dock:** a sticky 48 px header, a scrolling body and an optional sticky footer. Sections are separated by hairlines.
  - Section padding is 10 / 16 / 12 px.
  - Section head: 20 px tall with an 8 px gap below.
- **Status bar** (28 px, full width): items are separated by hairlines and have 10 px side padding. Left group, flexible space, then the right group.

### Spacing scale

4, 8, 12, 16, 24, 32, 40 and 48 px. The only intentional off-scale values are optical:

- 10 px section top padding;
- 6 px label gaps;
- 14 px numeric scale height.

### Frame sizing (real build)

Compute the cell size from the stage size; never stretch the canvas:

```
fit      = min((stageW - 28 - 2*pad) / (cols*cellW), (stageH - 24 - 26 - 2*pad) / (rows*cellH))   pad = 32
zoom     = user zoom or fit;  displayed % = zoom * cellW / cellW_export_1x  (e.g. 75%)
drawW    = round(cols * cellW * zoom), drawH = round(rows * cellH * zoom)   // device px: multiply by DPR
```

The boards use cell widths of 6, 5.6 (video), 5 (≤ 1280) and 4 (≤ 1100) px to stand in for "fit".

### Breakpoints

| Width | Changes |
|---|---|
| ≥ 1281 | As drawn. Dock is 336 px. |
| 1101–1280 | Dock 304 px. Value fields 52 px. Source meta drops the file size. Status bar drops GPU. Format tiles and fact cells tighten their padding. |
| 641–1100 | Ruler labels thin to every 20 columns, so numerals stay at 10 px. The transport hides In / Out / Dur (they stay in the export sheet and keyboard ⇧I / ⇧O), and Loop becomes icon plus kbd; on a stage ≤ 640 px the frame counter and duration go and the speed segment collapses to a "1× ▾" menu. GitHub becomes icon-only (with an `aria-label` and tooltip). **Mode tiles keep their labels** (5 × 51 px tiles fit "Halftone" at 12 px). At 1024 × 768 the dock body scrolls; Mode, Grid and Tone stay above the fold. Below about 900 px the start screen's URL field takes its own line under Choose file / Paste / Camera. |
| ≤ 500 tall (wider than 640) | A phone in landscape or a short window: the rulers, dimension lines and caption are hidden and the fit padding drops to 8 px, and the timeline strip is 28 px, so the preview keeps most of the stage. |
| ≤ 640 (phone) | Single column. Top bar shows the wordmark, an Open icon button, Export and a ⋯ More button. More opens a sheet with what the hidden desktop chrome offered: Undo / Redo and Reset all, the view (Output / Split / Source, and what Split compares with), zoom (Out / In / Fit / 100%), the built-in and saved looks with Save as preset… and Copy settings link, Paste / Camera / Close file, and the Shortcuts sheet. A mode strip (5 tiles, 52 px) is pinned under the top bar. The preview is full width at 16:9 with a one-line readout ("Grid 160 × 45 · Render 2.4 ms · FPS 60"; a clip shows its transport there instead, a camera both). While the sheet is at Full, toasts sit under the top bar instead of over the sheet. The dock becomes a bottom sheet with Adjust / Glyphs / Color tabs. Rulers, the stage header and the status bar are hidden. The transport becomes a strip above the sheet: prev, play, next, timecode, loop and the timeline with trim. |

### Phone sheet

- **Detents** (snap on release; drag the 36 × 4 grabber):
  - Peek: 112 px. Use it for video, and whenever the preview needs ≥ 40% of the viewport height.
  - Half: 47%, the default.
  - Full: 88%. Export always opens at full (86–88%), with a sticky footer for Download.
- **Shape:** 14 px top radius, `--line-2` top edge, shadow `0 -12px 32px rgba(0,0,0,.5)`. This is the only large shadow in the app.

---

## 3. Foundations

### Colour roles (see `tokens.css` for values)

- **Surfaces:**
  - `--g0` stage;
  - `--g1` chrome;
  - `--g2` controls at rest;
  - `--g3` hover and selected;
  - `--g4` pressed, rail and switch-off track.
- **Hairlines:**
  - `--line` dividers;
  - `--line-2` control borders;
  - `--line-3` hover and selected borders.
- **Text:**
  - `--tx-1` primary;
  - `--tx-2` secondary and values in captions;
  - `--tx-3` labels. This is the floor for any readable text.
  - `--tx-4` is for disabled text and decoration only.
- **Accent `--acc`:** allowed in exactly these places:
  - the primary action;
  - the selected mode tile, segment, format tile or tab (as a 2 px underline);
  - focus rings;
  - the dragged or focused slider thumb and fill;
  - the playhead and its frame flag;
  - the ruler cursor ticks and the probed-cell outline;
  - the encode meter;
  - the Encoding status dot;
  - the drop-zone drag-over edge.

  Nothing else uses it, including thumbs at rest, LEDs, dimension lines and status at rest.
- **`--danger`:** error icons only. Error text stays `--tx-1` / `--tx-2`.
- **Render:**
  - `--ink`, `--ink-shadow` and `--paper` are the default swatch values the GPU draws with.
  - `--k1…--k5` are the five duotone tone steps used by the DOM mocks. The real renderer computes `mix(shadowInk, ink, smoothstep(L̄))` per cell (ALGORITHM §7).

### Type

**Typefaces:** Geist (UI) and Geist Mono (labels, readouts, kbd and the ASCII itself). The Geist Mono advance is exactly 0.6 em, so `fontSize = cellW / 0.6` and `lineHeight = 2 × cellW` (k = 2). All changing numbers use `font-variant-numeric: tabular-nums`.

| Token | Size / line | Face | Use |
|---|---|---|---|
| fs-10 | 10/1, +0.08em caps | Mono | Ruler numerals, status keys, fact labels, timeline seconds. **Floor.** |
| fs-11 | 11/16, +0.1em caps | Mono 500 | Section heads (MODE, GRID…). |
| fs-11 | 11/16 | Mono | Kbd, status values, captions, chips. |
| fs-12 | 12/18 | Sans / Mono | Hints, sublabels, values in fields. |
| fs-13 | 13/1.4 | Sans 400/500 | Body, control labels (sentence case), buttons (500), primary button (600). |
| fs-14 | 14/1 | Sans 500 / Mono 500 | Wordmark "Renderer", timecode. |
| fs-18 | 18/30 | Mono 500 | Columns value. |
| fs-24 | 24/1, −0.02em | Mono 500 | Export pixel readout. |
| 19 | 19/24 | Sans 500 | Drop-zone title. |
| fs-40 | 40/44, −0.03em | Sans 500 (+ Mono 500 for "type.") | Start headline (28/32 on phone). |

Caps rule: tracked uppercase appears only in section heads, ruler and axis labels, status keys and fact labels. Everything a user reads to make a decision is sentence case.

### Radii

- 2 px: ruler marks, playhead flag.
- 3 px: kbd, chips, swatch chips.
- 4 px: buttons, fields, segments, selects, switch.
- 6 px: tiles, cards, drop zone, toasts.
- 14 px: phone sheet top corners.
- The Split handle and the start-tile corners are the only round elements.

### Elevation

Hairlines first. `--shadow-pop` is used only on popovers, menus, toasts, the probe tag and the Split handle. The phone sheet has its own shadow. Nothing sits on the stage with blur.

---

## 4. Screens

### 4.1 Start (`a-start.html`)

- **Content width:** 1040 px. The hero grid is `1fr 360px` and bottom-aligned.
- **Headline:** "Images, GIFs and video, rendered in type." The word "type." is set in Geist Mono in `--ink`, not the accent.
- **Hero description:** "Match each cell of your image or video to the glyph with the closest shape and export it as an image, text or video without leaving your browser."
- **Drop zone:** 280 px tall. It has a 22 px ruler strip on top (one numeral every 10 columns, which ties it to the editor) and a 16 px dot grid in `--line-2`.
- **Centre stack:**
  - a 40 px icon tile;
  - the title;
  - the actions row: Choose file ⌘O (primary), Paste ⌘V and Camera (secondary; Camera only where the page may use one), "or", and a 320 px URL form: the field and a separate 32 px secondary Load button 8 px after it (disabled while the field is empty);
  - the formats line.
- **Samples:** three 336 px tiles. Each shows a live ASCII preview (72 × 20 cells) above a 44 px footer with an icon, name, mono meta and a kbd 1–3.
- **Header and footer:** both sticky with solid `--g1` fills and hairlines; the page scrolls between them. The header holds the wordmark, Shortcuts ? and GitHub (the GitHub mark; icon-only on phones).
- **Footer** (44 px, 40 px on phones): "ASCII Renderer v0.1.0" on the left, "Files stay on your device" (lock icon) on the right. This is the start screen's only privacy line.
- **Phone:** stacked. The title reads "Open an image, GIF or video". Buttons go full width. Tiles become rows with a 120 px preview.
- **Opening:** while the first file loads, the start screen stays and the drop zone title reads "Opening torus.png…" over an indeterminate meter; a file that fails leaves the start screen as it was.
- **Drag-over:** the whole window is a drop target. The drop zone border and dot grid switch to accent and the title becomes "Release to open sunset.gif" with its meta (see `*-states`).

### 4.2 Editor, image (`a-editor.html`)

- **Stage:** a 160 × 45 Shape render of `torus.png`, default colour Duotone. Rulers in grid units: a numeral every 10 columns and 10 rows, ticks every 5 and 10.
- **Hover:**
  - The probed cell gets a 1 px accent outline.
  - Accent ticks on both rulers mark its column and row.
  - The probe tag ("C035 R22 [d] L 0.83") sits beside the cell on the emptier side. It never covers the cell, flips at the frame edges and is hidden while any slider is being dragged.
- **Caption:** "Source 1280 × 720 · Output 1280 × 720 px at 1× · Aspect locked 16:9". It is live: when the aspect check fails it shows the warning icon and the delta.
- **Dock sections**, in order:
  - **Mode:** 5 tiles in a radiogroup. M cycles. A one-line hint explains the selected mode.
  - **Grid:** the Columns hero (18 px value field, 40–400 scale with labelled major ticks at 40 / 100 / 200 / 300 / 400). The head shows the derived "rows 45 auto · cell 8 × 16".
  - **Tone:** Brightness (bipolar), Contrast, Gamma, Edge sharpness, plus an Invert switch (I).
  - **Edges** (Shape and Ramp): a "Contour lines" switch (strokes `| / \ - _` along strong edges, over the fill) and a Threshold slider that stays in place, disabled, while the switch is off.
  - **Glyphs:** a charset select with a density-sorted preview string.
  - **Color:** Mono / Source / Duotone segments. Shadow, Ink and Paper swatches (Ink and Paper only in Mono; none in Source).
  - **Advanced:** collapsed. Dither, font, cell, line height.
- **Dock header:** "Adjust", a Presets menu (save, load, built-ins, delete, and "Copy settings link": a URL that opens the app with these parameters; files are never part of it) and Reset all.
- **Status bar:** Live · Mode · Grid · Render · FPS · GPU, then Cursor · Zoom · On-device.

### 4.3 Editor, video or GIF (`a-editor-video.html`)

The stage and dock are the same as the image editor, plus the transport docked to the bottom of the stage.

- **Transport row** (48 px):
  - prev frame, play / pause and next frame;
  - timecode "00:01.42 / 00:04.00" (14 px mono);
  - "FRAME 034 / 096";
  - flexible space;
  - In and Out timecode fields (editable; ⇧I / ⇧O set them at the playhead) and "DUR 2.75 s";
  - Loop (toggle button with kbd L);
  - speed segment 0.5× / 1× / 2×.
- **Timeline** (18 px seconds ruler and a 40 px strip):
  - The strip shows halftone thumbnails drawn on a canvas, about one every 6 frames, regenerated lazily.
  - The area outside the trim range is dimmed with `--g0` at 72%.
  - Trim range: 2 px `--tx-1` rails top and bottom, plus 10 px handles with a grip.
  - Playhead: a 2 px accent line with a frame flag ("034") that rides above the ruler.
- **Dock changes:**
  - The hint and parameters follow the mode: Ramp replaces Edge sharpness with Dither.
  - A **Motion** section: Stability (0–1) and Output fps (12 / 15 / 30 / Src 24).
  - Glyphs and Color collapse to one-line summary rows with a chevron.
- **Status bar:** Playing · Rate · Grid · Render ms/f · FPS · Decode (WebCodecs or the media element), then Cursor · Zoom · On-device. (An earlier board showed a "Cached n / N fr" readout; it was dropped: frames decode on demand, so there is no cache worth reporting.)
- **Camera** (a live source): the source chip shows a "Live" badge; the transport is a play / pause button (pause freezes the frame) and "CAMERA 1280 × 720 · 30 fps", with no timeline, trim or speed. Closing the file stops the camera.

### 4.4 Export, image (`a-export.html`)

- **Opening:** Export (⌘E) swaps the dock to the Export panel with a 240 ms cross-fade; Esc or the back arrow returns. The primary button shows `aria-expanded="true"` with a 3 px accent halo.
- **Stage:**
  - The rulers are replaced by neutral technical-drawing dimension lines ("2560 px" and "1440 px", `--tx-3` lines with `--tx-1` labels).
  - The art is never dimmed. The transparent checker appears only when Transparent background is on.
  - Caption: "Source 1280 × 720 · Output 2560 × 1440 px at 2× · ✓ No crop, no squash".
- **Format:**
  - Still row: PNG Raster, SVG Vector, TXT Text, HTML Web page.
  - Motion row: GIF, MP4 H.264, WebM VP9. These are disabled for stills, with the reason underneath.
- **Size:**
  - A 44 px two-line segment: 1× / 2× / 4× / Custom, each with its exact pixels.
  - Output card: the 24 px readout "2560 × 1440 px" and the aspect glyph (solid = output, dashed = source at the same scale).
  - Check line, computed (see §7).
  - Facts: Grid · Glyph px · Est. size. A GIF's size is measured from real delta frames sampled across the clip; when they disagree it shows as a range ("≈ 1.9–3.1 MB"), and the large-file note follows the upper bound.
- **Options:**
  - Transparent background (switch, with the sub "Drops the paper; glyphs keep their ink").
  - Pixel-snap glyphs: on and locked at the whole scales, with the reason as its sub ("Always on at 1×, 2× and 4×: whole-pixel cells. Choose Custom to resample."); at a custom width it is off ("cells are resampled") and turning it on snaps to the nearest whole scale.
  - File name, with a fixed extension suffix.
- **Custom:** a width field; the file is exactly that wide (rendered at the next whole scale and shrunk in linear light, height from the aspect). The hint gives the resampled cell size and offers the nearest whole scale for crisp cells.
- **Footer** (sticky): the copy action for the format (Copy PNG, Copy SVG or Copy text; secondary) and Download PNG ⌘↵ (primary, flex 1).

### 4.5 Export, video encoding (`a-export-video.html`, extra)

- **Formats:** each still format's sublabel reads "Frame" (PNG, SVG, TXT and HTML all export the frame at the playhead).
- **Options:**
  - Trimmed range only (on) shows "00:00.50 – 00:03.25 · 66 of 96 frames".
  - Transparent background is disabled with "MP4 has no alpha channel. Use WebM."
- **Footer while encoding:**
  - "Encoding in a worker. Keep editing." with "62%" at 18 px mono;
  - a tick meter;
  - "Frame 41 / 66 · 00:02 left" and "WebCodecs · H.264";
  - Cancel, and Save MP4 (disabled until done).
- **Status bar:** an accent dot and "Encoding", Codec, Frames, Speed 2.6× realtime.
- **Settings lock:** the encode uses a snapshot of the settings. Editing during the encode does not affect it.
- **Scale:** motion formats keep their own scale, 1× by default (a 2× GIF is easily 4× the bytes). Est. size shows for every format; above 15 MB a warning says what makes the file smaller.
- **Camera:** MP4 and WebM read "Record"; GIF is disabled with its reason. While recording, the footer shows "Recording the preview, edits included.", the elapsed time, frames, Discard, and Stop and save MP4 ⌘↵ (primary). The status bar reads "● Recording · CONTAINER MP4 · TIME 00:12.40 · FRAMES 372".

### 4.6 Split compare (`a-compare.html`, extra)

- **Layout:** the source raster (a real `<img>` or texture, grayscale only if the source is) sits under the same frame, clipped at `--split`. A 1 px `--tx-1` divider and a 32 px round handle (`role="slider"`; ← → move 1%, Shift moves 10%).
- **Chips:** "Original" top-left and "ASCII · Shape" top-right.
- **Compare with:** in Split, the stage header shows a "vs Original ▾" menu: Original (the source) or Ramp render (the same picture in plain Ramp, density only). Against Ramp the chips read "ASCII · Ramp" | "ASCII · Shape" (and "+ contours" while contour lines are on). Phones choose it in the More sheet.
- **Caption:** "Split 50% · Drag the handle, or focus it and use ← → · Press S to toggle".
- **Drag state:** the board also shows a slider being dragged (Contrast): accent thumb and fill, and an accent border on its value field.

---

## 5. Components

Sizes are desktop sizes. Every interactive element has a hit area of at least 32 × 32 px.

### Button (`.btn`)

- **Anatomy:** 32 px tall, 12 px padding, 8 px gap, 4 px radius, 13 px / 500. A 16 px icon comes first; an optional kbd comes last (−4 px right margin).
- **Variants:**
  - **Primary:** `--acc` background, `--acc-ink` text, 600 weight. One per screen.
  - **Secondary:** `--g2` with a `--line-2` border.
  - **Ghost:** transparent, `--tx-2`.
  - **Icon:** 32 × 32. `.sm` is 28 px.
- **States:**
  - Hover: `--g3` with `--line-3` (ghost: `--g2`, `--tx-1`); primary goes to `--acc-hi`.
  - Active: `--g4` (primary: brightness 0.92).
  - Focus-visible: 2 px `--acc` outline, 2 px offset.
  - Disabled: `--g1`, `--line`, `--tx-4`; disabled primary: `--g3`, `--tx-3`.
  - Pressed toggle (`aria-pressed`): `--g3` with `--line-3`.
  - Expanded primary: a 3 px `--acc-line` halo.

### Kbd

11 px mono, 16 px line, 4 px padding, 3 px radius, `--line-2` border, `--tx-3`. Inside the primary button: transparent background, a border of `--acc-ink` at 32%, text `--acc-ink`.

### Segmented control (`.seg`)

- **Anatomy:** 32 px total height; options divided by `--line-2`; `--g1` ground.
- **Selected:** `--g3`, `--tx-1`, and a 2 px accent underline (inset box-shadow, animated 160 ms).
- **Variants:**
  - `.mono` for numbers.
  - `.two` (44 px) for a label plus a sub-value, as in the scale picker.
- **Roles:** `role="radiogroup"` / `radio` for exclusive choices (modes, colour, scale, speed, fps); `aria-pressed` buttons for the view switch.
- **Keyboard:** arrow keys move the selection within a radiogroup.

### Mode tile (`.mode`)

- **Anatomy:** 56 px tall (52 px in the phone strip), 6 px radius. A specimen sits above a 12 px / 500 label. Specimens:
  - Shape `/|\_` and Ramp `.:+#` are set in mono;
  - Braille, Halftone and Blocks are SVG (no font dependency).
- **States:**
  - Selected: `--g3`, `--line-3` border, `--tx-1`, and a 2 px accent bar flush with the bottom edge.
  - Hover: `--g3`.
  - Focus: outline with a 1 px offset.
- No LEDs.

### Slider row (`.row`)

- **Grid:** `96px | 1fr | 56px` (52 px value at ≤ 1280), 8 px gaps, 32 px tall, 4 px between rows.
- **Label:** 13 px `--tx-2`, sentence case. It is a scrub handle too (`cursor: ew-resize`).
- **Track** (32 px hit area), stacked:
  - ticks: 1 px wide, 5 px minor every 10% and 9 px major at the ends, in `--tick`;
  - lit ticks: `--tick-on`, clipped to the filled range;
  - rail: 2 px `--g4`;
  - fill: 2 px `--tick-on`;
  - thumb: 3 × 18 px `--tx-1`, with a 2 px `--g1` cut-out ring.
- **Bipolar** (Brightness): a 1 × 13 px `--tx-3` centre detent at 50%; the fill grows out from the centre.
- **States:**
  - Rest: neutral thumb and fill.
  - Hover: thumb grows to 20 px.
  - Dragging: thumb and fill turn `--acc`, and the value field gets an `--acc-line` border. The canvas re-renders on every `input` event, with no apply step.
  - Focus-visible: accent thumb, plus a 2 px `--acc-line` halo outside the cut-out.
  - Disabled (`.row.off`): `--tx-4` label and value, `--tx-4` thumb, `--g4` fill. Prefer hiding parameters the current mode does not use; disable only when hiding would shift the layout during a transition.
- **Implementation:** a native `<input type="range">` at opacity 0 sits over the drawn track. It provides keyboard, AT and pointer support in every browser. The visual parts are plain elements driven by `--p` (0–100%) and `--a` (anchor: 0% or 50%).
  - The lit ticks use `clip-path: inset(0 calc(100% - max(a,p)) 0 min(a,p))`. If `min()` inside `inset()` is unsupported, set the two insets from JS.
  - No CSS `round()` is needed.
- **Keyboard:**
  - ← → step 1% of the range; Shift multiplies by 10.
  - Home / End go to min / max.
  - Backspace or a double-click on the label resets to the default.
- **Pointer:**
  - Click the track to jump.
  - Drag the thumb.
  - Drag horizontally on the label or value field to scrub: 1 px = 0.5% of the range, Shift = 0.05%.

### Value field (`.val`)

- **Anatomy:** 32 px tall, `--g2`, `--line-2` border, 12 px mono, right-aligned, tabular.
- **States:**
  - Hover: `--line-3` / `--g3`, `ew-resize`.
  - Editing (focus): `--g0`, a 1 px `--acc` border plus a 1 px `--acc` ring, text cursor. Enter commits, Esc reverts.
  - Invalid: revert to the last valid value and clamp. Never show an error state for a number.
- **Hero variant** (`.val.big`): 72 × 32 px, 18 px mono 500, used for Columns.

### Switch row (`.swrow`)

- **Row:** the whole 32 px row is a `<label>` (40 px with a sub-line).
- **Switch:** 30 × 18 px, 4 px radius, 12 px square knob.
  - Off: `--g4` track, `--line-3` border, `--tx-3` knob.
  - On: `--tx-1` track with a `--g1` knob. It stays neutral: state is shown by luminance, not accent.
  - Disabled: `--g2` with a `--tx-4` knob, and the row text goes to `--tx-4`. A reason sub-line in `--tx-3` stays readable.
- **Motion:** the knob moves over 160 ms on `--ease-out`.

### Select and listbox

- **Trigger:** 32 px, `--g2`, 10 px left padding. It shows the value, a mono aux (`--tx-3`) and a chevron.
- **Menu:** opens 4 px below, 240 px wide, 4 px inner padding, `--g2`, `--shadow-pop`.
  - Options: 32 px, 4 px radius. Selected: `--g3` with a check.
  - A hairline separates the Custom… option.
- **Charset preview:** the line under the trigger is the glyph set sorted by measured coverage, fading out on the right, annotated "by density".
- **Custom…:** opens an inline text field. Glyphs are de-duplicated and the count updates live.

### Swatch and colour popover

- **Swatch:** a 40 px button with a 16 px chip (inset 1 px white at 12%), a name (11 px `--tx-3`) and a hex value (12 px mono, uppercase).
- **Popover:** 240 px. Saturation/value plane, hue strip, and a hex field with alpha. Changes preview live.

### Section and disclosure

- **Section head:** 11 px mono caps. The aux sits on the right (12 px mono `--tx-2`, with `--tx-3` em parts).
- **Disclosure row:** a 36 px button with the caps head, a right-aligned summary (sans 12 px) and a chevron. `aria-expanded` is set. The chevron rotates 90° over 160 ms.

### Format tile (`.fmt`)

- **Anatomy:** 44 px, 6 px radius, 4 per row. The name is 12 px mono 500; the sublabel is 11 px `--tx-3`, with no wrapping.
- **States:**
  - Selected: same treatment as the mode tile.
  - Disabled: transparent, `--line` border, `--tx-4`. The reason is shown as a hint line under the group.

### Output card

- **Anatomy:** `--g0` with a `--line-2` border and 6 px radius. Readout plus aspect glyph (64 × 40), then the check line, then three facts (10 px caps label, 12 px mono value) separated by hairlines.
- **Check line:** it is computed (§7).
  - OK: a check icon in `--tx-1`.
  - Warning: an alert icon in `--danger`, the delta, and a one-click fix ("Fit exactly").

### Text field (`.field`)

32 px, `--g2`. The placeholder is in sans; the value is in mono for file names and URLs. Fixed suffix: an extension or "100%". It can hold an inline `.btn.sm` (Load).

### Tick meter (progress)

- **Anatomy:** 16 px tall; 2 px ticks on a 5 px pitch. Unfilled ticks are `--tick`; filled ticks are `--acc`.
- **Accessibility:** `role="progressbar"` with `aria-valuenow`. A text line above carries the percentage.
- **Indeterminate** (decode before the frame count is known): a 25% window slides at 1.2 s linear.

### Transport and timeline

See §4.3 for anatomy.

- **Play button:** a 32 px `--tx-1` filled square with a `--g1` icon. It is neutral, because the accent belongs to Export.
- **Trim handles:** `role="slider"`. ← → move 1 frame (Shift: 10). Focus-visible gives a 2 px accent outline.
- **Playhead:** draggable and shift-snaps to whole seconds. The flag always shows the frame number.
- **Strip:** `role="slider"` with `aria-valuetext` such as "Frame 34, 1.42 seconds".
- **Keyboard:**
  - Space: play / pause.
  - ← →: one frame.
  - ⇧I / ⇧O: set in and out.
  - L: toggle loop.
  - J / K: 0.5× / 1×.

### Status bar

- **Items:** a key (10 px caps `--tx-3`) followed by a value (11 px mono `--tx-2`; `--tx-1` for the state word).
- **Alignment:** every item is `display: flex; align-items: center; height: 100%`, so nothing drops off the baseline. Icons are 12 px.
- **Status dot:** 6 × 6 px with 1 px radius. It is `--tx-2` (neutral) at rest and `--acc` only while encoding.

### Rulers

- **Drawing:** a small 2D canvas on each axis, redrawn on zoom or pan. Never use DOM labels in the real build.
- **Numerals:** 10 px mono `--tx-3`.
- **Ticks:** 7 px every 10 units in `--tick-on`; 4 px every 5 units in `--tick`.
- **Density:** labels thin out so they are at least 36 px apart (every 10, 20, 50 or 100), and they never scale below 10 px.
- **Cursor ticks:** one cell wide and 7 px deep, in `--acc`.

### Cell probe

- **Outline:** 1 px `--acc` box-shadow on a cell-sized element.
- **Tag:** 24 px tall, 11 px mono, `--g1`, `--line-2`, `--shadow-pop`. It contains the column / row, the glyph in a 16 px `--g3` chip and the luminance.
- **Layers:** the outline and tag are absolutely positioned overlay layers moved with `transform` only, never part of the WebGL pass. They appear 80 ms after the pointer enters the frame.

### Dimension lines (export)

- **Lines:** 1 px `--tx-3` with 9 px end ticks.
- **Labels:** 11 px mono 500 `--tx-1` on a `--g0` knockout with 8 px side padding. The height label is rotated −90°.

### Toast

- **Anatomy:** 380 px, `--g2`, `--line-2`, 6 px radius, `--shadow-pop`. A 16 px icon, a title (13 px / 500), a body (12 px `--tx-2`), and optional actions (`.btn.sm`). The dismiss × is 28 px.
- **Placement:** bottom centre of the stage, 16 px above the status bar or transport. They stack upward with 8 px gaps, three at most.
- **Timing:** success and info dismiss after 5 s, paused on hover or focus. Errors stay until dismissed.
- **Announcements:** each toast is announced once, by the toast host's own live regions (assertive for errors, polite for the rest), which hold the newest toast's title and body; the cards themselves carry no live role, and actions that raise a toast do not also announce. A toast keeps its own clock across screens (start screen → editor), so it never restarts its 5 s.
- **Error copy:** the boards show the canonical strings for an unsupported file, a decode failure, a successful save and copied text.

### Drop zone and empty state

- **Drop zone:** see §4.1.
- **Editor drag-over:** a dashed 1 px `--acc` inset frame (10 px in) over the stage with `--g0` at 70%, and a centred pill reading "Drop to replace torus.png".
- **Drop rules:**
  - Unsupported types are rejected on dragenter: the cursor shows not-allowed and no accent appears.
  - A drop that turns out unsupported raises the error toast.

### Tabs (phone sheet) and mode strip

- **Tabs:** 44 px, equal widths. Selected: `--tx-1` with a 2 px accent underline. `role="tablist"`.
- **Mode strip:** the same tiles at 52 px, 4 px gaps, 12 px side padding, `--g1`.

---

## 6. States matrix

| Component | Hover | Focus-visible | Active / selected | Disabled | Dragging | Loading / progress | Error |
|---|---|---|---|
| Button | `--g3` / `--line-3` | 2 px accent outline +2 | `--g4`; toggles `--g3` | `--tx-4` | n/a | Label becomes "Exporting…"; width does not change | n/a |
| Segment | `--g2`, `--tx-1` | inset 2 px accent | `--g3` + underline | `--tx-4` | n/a | n/a | n/a |
| Slider | thumb 20 px | accent thumb + halo | n/a | `.row.off` | accent thumb + fill, field border | n/a | n/a |
| Value field | `--line-3`, ew-resize | 1 px accent border + ring | n/a | `--tx-4` | scrubbing: ew-resize everywhere | n/a | reverts and clamps |
| Switch | track `--line-3` → `--tx-3` | outline | on = `--tx-1` | `--g2` + reason | n/a | n/a | n/a |
| Mode / format tile | `--g3` | outline +1 | `--g3` + 2 px bar | transparent, `--tx-4`, reason line | n/a | n/a | n/a |
| Drop zone | border `--line-3` | outline on the Choose file button | n/a | n/a | accent edge + dot grid, "Release to open …" | n/a | toast |
| Stage | n/a | n/a | n/a | n/a | dashed accent frame "Drop to replace" | first frame: 2 px indeterminate meter under the stage header | toast; stage keeps the last good frame |
| Timeline | handle grip `--g3` | accent outline | playhead accent | n/a | dragged handle shows a timecode tooltip | cached region tinted `--tx-1` at 10% | n/a |
| Export footer | n/a | n/a | n/a | Save disabled until done | n/a | tick meter, %, frames, ETA, Cancel | toast "Export failed: …" with Try again |

---

## 7. Behaviour that the visuals depend on

### Export dimension truth (fixes "export shrinks my image")

This follows ALGORITHM §1. At integer scale `s` with integer cells:

```
outW = cols * cellW * s,  outH = rows * cellH * s          // pixel-snap ON (default)
rows = max(1, round(cols * H / W * cellW / cellH))
```

Run the check line from integers, never from a rounded label:

```
srcAR = W / H;  outAR = outW / outH;  d = outAR / srcAR - 1
if outW == W*s && outH == H*s      -> "Matches source W × H exactly: a:b, no crop, no squash."   (✓ --tx-1)
else if |d| <= 0.5/rows (rounding)  -> "Rows round to R, so the aspect is x.xxx against the source’s y.yyy (+d%). Fit exactly uses fractional cells (cw × ch px) instead."  (⚠ --danger, offers fix)
custom width                         -> exactly that width: render at the next whole scale, shrink in linear light, height = round(width · outH / outW); the hint names the resampled cell and offers the nearest whole scale.
```

- **Exact match:** the default sample uses 160 columns with an 8 × 16 cell, so 1280 × 720 is matched exactly.
- **Pixel-snap off:** "Fit exactly" with fractional cells, shown as `cell 8.53 × 17.14 px`.
- **H.264** (MP4) needs even sizes. Pad to the next even size with paper and say so ("padded to 1280 × 720 (+1 px)"). Never scale.
- **Size limits:** clamp to `MAX_TEXTURE_SIZE` by tiling, and show the final size before saving.

### Live preview

Every control writes to the store on `input`, not `change`. The renderer coalesces to one draw per animation frame. Render time in the status bar is the GPU time of the last frame (EXT_disjoint_timer_query) or the CPU wall time as a fallback.

### Fonts

- Self-host Geist and Geist Mono as woff2 (`@fontsource`). This keeps the app working offline and consistent with "nothing leaves your device".
- `await document.fonts.load('16px "Geist Mono"')` before building the glyph atlas.
- **Braille** (U+2800 block) and block elements are drawn procedurally (ALGORITHM §6). Geist Mono has no Braille, so a DOM Braille preview would misalign.
- TXT, HTML and SVG exports declare a fallback stack that covers Braille and blocks: `"Geist Mono", "DejaVu Sans Mono", "Noto Sans Symbols 2", monospace`.

### Performance guardrails

- No `backdrop-filter` or blur anywhere over the stage.
- Overlays (probe, ruler cursor, Split divider, drag-over frame) are transform-only, `will-change: transform` and `pointer-events: none` where possible.
- Filmstrip thumbnails are drawn into one canvas strip in a worker and filled in progressively.

---

## 8. Motion

Keep motion subtle; nothing loops except progress.

| What | Duration | Easing |
|---|---|---|
| Hover colour, border | 90 ms (`--t-fast`) | linear |
| Segment underline, switch knob, tooltip, chevron rotate | 160 ms (`--t-base`) | `--ease-out` cubic-bezier(.2,.7,.2,1) |
| Dock panel swap (Adjust ↔ Export) | 240 ms (`--t-slow`) cross-fade + 8 px slide | `--ease-in-out` |
| Phone sheet detent snap | 240 ms | `--ease-out`; follows the finger 1:1 while dragging |
| Toast in / out | 160 ms, 8 px rise + fade | `--ease-out` |
| Probe appear | 80 ms delay, 90 ms fade | linear |
| Encode meter | ticks fill in steps (no tween) | n/a |
| Indeterminate meter | 1.2 s loop | linear |

- Never animate the canvas size, slider values or the preview: parameter changes are instant.
- `prefers-reduced-motion: reduce`: drop the slides, keep the fades at ≤ 90 ms and stop the indeterminate loop. Static "Loading…" text is shown instead.

---

## 9. Iconography

- **Grid:** hand-drawn on a 16 px grid with a 1.5 px stroke, round caps and joins, `fill: none`, `stroke: currentColor`. `play` and `pause` are filled.
- **Sizes:** 16 px in controls, 12 px in the status bar and caption, 20 px only if a larger target needs it (scale the stroke to 1.75).
- **Markup:** `<svg viewBox="0 0 16 16" aria-hidden="true">`. The label always lives on the button.

| Name | Used for | Path data (viewBox 0 0 16 16) |
|---|---|---|
| `upload` | drop zone | `M8 10V2.75M4.75 6 8 2.75 11.25 6M2.75 10.5v1.75c0 .55.45 1 1 1h8.5c.55 0 1-.45 1-1V10.5` |
| `download` | Download / Save | `M8 2.75V10M4.75 6.75 8 10l3.25-3.25M2.75 10.5v1.75c0 .55.45 1 1 1h8.5c.55 0 1-.45 1-1V10.5` |
| `export` | Export (top bar) | `M8 9.25v-6.5M5.5 5.25 8 2.75l2.5 2.5M5.75 7H4.25c-.55 0-1 .45-1 1v4.25c0 .55.45 1 1 1h7.5c.55 0 1-.45 1-1V8c0-.55-.45-1-1-1h-1.5` |
| `folder` | Open / Choose file | `M2.25 4.75c0-.55.45-1 1-1h2.9l1.4 1.5h5.2c.55 0 1 .45 1 1v5.5c0 .55-.45 1-1 1H3.25c-.55 0-1-.45-1-1z` |
| `paste` | Paste | `M5.75 3.25h-1.5c-.55 0-1 .45-1 1v8.5c0 .55.45 1 1 1h7.5c.55 0 1-.45 1-1v-8.5c0-.55-.45-1-1-1h-1.5M6.25 2.25h3.5v2h-3.5z` |
| `link` | URL field | `M6.75 9.25l2.5-2.5M7.25 4.75l.9-.9a2.47 2.47 0 0 1 3.5 3.5l-.9.9M8.75 11.25l-.9.9a2.47 2.47 0 0 1-3.5-3.5l.9-.9` |
| `x` | close file, dismiss | `M4.5 4.5l7 7M11.5 4.5l-7 7` |
| `undo` | undo | `M5.75 3.75 3 6.5l2.75 2.75M3 6.5h6.75a3.25 3.25 0 0 1 0 6.5H8` |
| `redo` | redo | `M10.25 3.75 13 6.5l-2.75 2.75M13 6.5H6.25a3.25 3.25 0 0 0 0 6.5H8` |
| `branch` | GitHub link | `M5 4.75v6.5M5 11.25a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM5 1.75a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM11 3.75a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM11 6.75c0 2.5-6 2-6 4.5` |
| `grid` | rulers toggle | `M6 2.75v10.5M10 2.75v10.5M2.75 6h10.5M2.75 10h10.5` |
| `minus` | zoom out | `M3.75 8h8.5` |
| `plus` | zoom in | `M8 3.75v8.5M3.75 8h8.5` |
| `fit` | fit to stage | `M2.75 6V3.75c0-.55.45-1 1-1H6M10 2.75h2.25c.55 0 1 .45 1 1V6M13.25 10v2.25c0 .55-.45 1-1 1H10M6 13.25H3.75c-.55 0-1-.45-1-1V10` |
| `split` | Split view | `M3.75 2.75h8.5c.55 0 1 .45 1 1v8.5c0 .55-.45 1-1 1h-8.5c-.55 0-1-.45-1-1v-8.5c0-.55.45-1 1-1zM8 2.75v10.5` |
| `image` | image source | `M3.75 2.75h8.5c.55 0 1 .45 1 1v8.5c0 .55-.45 1-1 1h-8.5c-.55 0-1-.45-1-1v-8.5c0-.55.45-1 1-1zM2.75 11l3-3 2.5 2.5 1.75-1.75 3.25 3.25M10.25 4.75a1 1 0 1 0 0 2 1 1 0 0 0 0-2z` |
| `film` | video / GIF source | `M3.75 2.75h8.5c.55 0 1 .45 1 1v8.5c0 .55-.45 1-1 1h-8.5c-.55 0-1-.45-1-1v-8.5c0-.55.45-1 1-1zM5.25 2.75v10.5M10.75 2.75v10.5M2.75 6h2.5M2.75 10h2.5M10.75 6h2.5M10.75 10h2.5` |
| `prev` | previous frame | `M4.25 3.75v8.5M11.75 4.2v7.6a.4.4 0 0 1-.63.33L6.1 8.33a.4.4 0 0 1 0-.66l5.02-3.8a.4.4 0 0 1 .63.33z` |
| `next` | next frame | `M11.75 3.75v8.5M4.25 4.2v7.6a.4.4 0 0 0 .63.33l5.02-3.8a.4.4 0 0 0 0-.66L4.88 3.87a.4.4 0 0 0-.63.33z` |
| `loop` | loop | `M2.75 7.25v-.5a2 2 0 0 1 2-2h8M10.75 2.75l2 2-2 2M13.25 8.75v.5a2 2 0 0 1-2 2h-8M5.25 13.25l-2-2 2-2` |
| `reset` | reset | `M2.75 2.75v3h3M3.1 5.75A5.25 5.25 0 1 1 2.9 9.5` |
| `check` | aspect OK, menu check | `M3.25 8.5l3 3 6.5-6.75` |
| `chev-d` | select, menu | `M4.5 6.25 8 9.75l3.5-3.5` |
| `chev-r` | disclosure | `M6.25 4.5 9.75 8l-3.5 3.5` |
| `arrow-l` | back from Export | `M12.75 8h-9.5M7.25 4l-4 4 4 4` |
| `lock` | on-device, aspect locked | `M4.25 7.25h7.5c.55 0 1 .45 1 1v4.5c0 .55-.45 1-1 1h-7.5c-.55 0-1-.45-1-1v-4.5c0-.55.45-1 1-1zM5.5 7.25V5.5a2.5 2.5 0 0 1 5 0v1.75` |
| `alert` | warning / decode error | `M8 2.75 14 13.25H2zM8 6.75v3M8 11.6v.01` |
| `info` | info note | `M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5zM8 7.25v4M8 4.9v.01` |
| `copy` | Copy text | `M6.25 5.75h6c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1h-6c-.55 0-1-.45-1-1v-6c0-.55.45-1 1-1zM10.25 5.75v-2c0-.55-.45-1-1-1h-5.5c-.55 0-1 .45-1 1v5.5c0 .55.45 1 1 1h1.5` |
| `keyboard` | Shortcuts | `M2.75 4.25h10.5c.55 0 1 .45 1 1v5.5c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1v-5.5c0-.55.45-1 1-1zM4.75 7h.01M7 7h.01M9 7h.01M11.25 7h.01M5.5 9.5h5` |
| `arrows-lr` | Split handle | `M5.5 5.25 2.75 8l2.75 2.75M10.5 5.25 13.25 8l-2.75 2.75` |
| `file-x` | unsupported file | `M9.25 1.75H4.75c-.55 0-1 .45-1 1v10.5c0 .55.45 1 1 1h6.5c.55 0 1-.45 1-1V4.75zM9.25 1.75v3h3M6.5 8.25l3 3M9.5 8.25l-3 3` |
| `more` | overflow menu | `M3.75 8h.01M8 8h.01M12.25 8h.01` |
| `sliders` | Adjust tab (phone, optional) | `M2.75 5h6.5M12.25 5h1M2.75 11h1M6.75 11h6.5M10.75 3.5v3M5.25 9.5v3` |
| `type` | Glyphs tab (phone, optional) | `M3.25 4.25v-1.5h9.5v1.5M8 2.75v10.5M6 13.25h4` |
| `drop` | Color tab (phone, optional) | `M8 2.25c2.5 3 4.25 5.1 4.25 7.25a4.25 4.25 0 0 1-8.5 0C3.75 7.35 5.5 5.25 8 2.25z` |
| `play` | play (filled) | `M5 3.4v9.2c0 .4.43.64.77.43l7.2-4.6a.5.5 0 0 0 0-.86l-7.2-4.6A.5.5 0 0 0 5 3.4z` |
| `pause` | pause (filled) | `M4.5 3.25h2.25v9.5H4.5zM9.25 3.25h2.25v9.5H9.25z` |

**Mode specimens** (SVG, `fill: currentColor`):

- **Braille:** 13 dots of r = 1.25 on a 4 px pitch, in a 22 × 16 box.
- **Halftone:** 4 dots of r = 1 / 1.8 / 2.6 / 3.4 in a 26 × 16 box.
- **Blocks:** 6 quadrant rectangles, each 3.5 × 7, in a 24 × 16 box.

See `ModeSpecimen` in `src/ui/icons.tsx`.

---

## 10. Accessibility

### Contrast (computed from `tokens.css`, WCAG 2.x relative luminance)

| Pair | Use | Required | Value |
|---|---|---|---|
| `--tx-1` on `--g1` | primary text | 4.5 | #EDEEF0 / #0F1011 = **16.41:1** |
| `--tx-2` on `--g1` | secondary text | 4.5 | #A6AAB2 / #0F1011 = **8.18:1** |
| `--tx-2` on `--g3` | secondary on hover/selected | 4.5 | #A6AAB2 / #1C1D20 = **7.23:1** |
| `--tx-3` on `--g0` | labels on stage | 4.5 | #868B94 / #09090A = **5.81:1** |
| `--tx-3` on `--g1` | labels on chrome | 4.5 | #868B94 / #0F1011 = **5.56:1** |
| `--tx-3` on `--g2` | labels in controls | 4.5 | #868B94 / #151618 = **5.29:1** |
| `--tx-3` on `--g3` | labels on selected tile (floor) | 4.5 | #868B94 / #1C1D20 = **4.92:1** |
| `--acc` on `--g1` | accent marks on chrome | 3 (non-text) | #FF6A2B / #0F1011 = **6.67:1** |
| `--acc` on `--g0` | focus ring on stage | 3 (non-text) | #FF6A2B / #09090A = **6.96:1** |
| `--acc-ink` on `--acc` | text on primary button | 4.5 | #140A05 / #FF6A2B = **6.83:1** |
| `--acc-ink` on `--acc-hi` | text on primary hover | 4.5 | #140A05 / #FF7D45 = **7.69:1** |
| `--tick-on` on `--g1` | slider fill / lit ticks vs chrome | 3 (non-text) | #7D828B / #0F1011 = **4.93:1** |
| `--tick-on` on `--g4` | slider fill vs rail | 3 (non-text) | #7D828B / #26282C = **3.82:1** |
| `--tx-1` on `--g1` | slider thumb vs chrome | 3 (non-text) | #EDEEF0 / #0F1011 = **16.41:1** |
| `--danger` on `--g2` | error icon in toast | 3 (non-text) | #FF6B73 / #151618 = **6.55:1** |
| `--ink` on `--paper` | render ink on paper (default) | n/a (artwork) | #E6E4DF / #0B0B0C = **15.48:1** |
| `--tx-4` on `--g1` | disabled text only | exempt | #5B5F67 / #0F1011 = **2.97:1** |

- **Hairlines:** `--line*` borders are decorative. Every control is identifiable without them, by its fill, label or position. Where a boundary carries meaning (switch track, value field), the state is also shown by a fill or a value of at least 3:1.
- **Focus:** every interactive element shows a 2 px `--acc` outline on `:focus-visible` (≥ 6.6:1 against every surface). Segments use an inset ring so it is not clipped. Value fields show focus with a border and ring.
- **Hit targets:** at least 32 × 32 px everywhere, with ≥ 4 px between neighbouring targets, which meets WCAG 2.5.8 with margin. On phone, sheet tabs are 44 px and mode-strip tiles 52 px. Icon-only buttons (undo, redo, rulers, zoom, close, prev / next, phone Open) carry an `aria-label` and a tooltip that shows the shortcut.
- **Roles:**
  - radiogroups for mode, colour, scale, speed and fps; `aria-pressed` for the view switch, rulers and loop;
  - `role="slider"` on the trim handles, Split handle and timeline;
  - `role="progressbar"` on the encode meter;
  - toasts announced through the toast host's live regions (`role="status"` / `alert`), once each;
  - `role="tablist"` on the phone sheet.
- **Preview:** the `<canvas>` has `aria-label="ASCII render of <file>, <cols> by <rows> cells"`. A "Copy text" action gives screen-reader users the actual content.
- **Announcements:** the status-bar render time is not live (too chatty). Mode changes, view and zoom actions, undo / redo and export start are announced through a polite live region; saves, copies, failures and decode errors through their toast, once.
- **Keyboard map** (shown in the Shortcuts sheet, `?`):
  - ⌘O open, ⌘V paste, ⌘E export, ⌘↵ download, Esc close export;
  - ⌘Z / ⇧⌘Z undo / redo;
  - M cycle mode, I invert, D duotone, R rulers, S split, F fit;
  - Space, ← →, ⇧I / ⇧O, L, J / K for video;
  - 1–3 for samples on the start screen.
- **Never colour alone:** disabled formats carry a reason line, warnings carry an icon and text, and selected tiles have a bar plus a border plus a brighter label.

---

## 11. Copy rules

- Sentence case everywhere except the caps micro-labels.
- Units are always shown: "px", "ms", "fps", "s", "fr".
- Use real numbers, never "N/A". If a value is unknown, show "–" and a tooltip explaining why.
- Say what will happen ("Release to open sunset.gif", "Drop to replace torus.png"). Say why something is disabled.
- Don't use the words "simply", "magic" or "AI". No emoji.
