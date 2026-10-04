# Rendering algorithm

This is the normative spec for the engine. The CPU reference (`src/engine/cpu.ts`) and the WebGL2 renderer (`src/engine/gl/`) must both implement it and agree glyph-for-glyph on still images (tests enforce this on the CPU side; the GPU side is checked against the CPU reference in the browser).

It follows Alex Harri's *ASCII characters are not pixels* (https://alexharri.com/blog/ascii-rendering).

## 1. Cell geometry (shared by everything)

Inputs: a bundled monospace font, a line-height factor `lh` (default 1.2), a base cell width `cellW` in px (default 8) and the source size `W × H` (after EXIF orientation).

```
advanceEm = ctx.measureText('M'.repeat(100)).width / 100 / F      // measured, never from ink boxes
k         = lh / advanceEm                                          // cell aspect (height / width); JetBrains Mono, lh 1.2 -> 2.0
cellH     = round(cellW * k)                                        // integer px at scale 1
fontSize  = cellW / advanceEm                                       // px; makes the advance exactly cellW
baseline  = round((cellH - (ascent + descent) * fontSize) / 2 + ascent * fontSize)   // fontBoundingBoxAscent / Descent
rows      = max(1, round(cols * H / W * cellW / cellH))
```

Raster output at integer scale `s` is exactly `cols·cellW·s × rows·cellH·s` px (plus optional margin `P·s` on each side, default 0). Glyph `(r, c)` is drawn with its pen at `x = c·cellW·s`, alphabetic baseline at `y = r·cellH·s + baseline·s`, `letterSpacing 0`, no kerning. All exporters (PNG, GIF, video, SVG, HTML, TXT) use these numbers. Never measure layout from ink bounding boxes and never truncate with `int()`/`floor` where `round` is meant.

Limits (enforced in the param schema, shown in the UI, never silent): `20 ≤ cols ≤ 400`, `rows ≤ 400`, `cols·rows ≤ 120 000`. When a tall source would exceed the row or cell limit, `gridSize` lowers the column count (never the row count alone), so the aspect rule above still holds; only sources taller than about 400:1 end up with clamped rows. Raster exports are clamped to the device's `MAX_TEXTURE_SIZE`/`MAX_RENDERBUFFER_SIZE` (tile above it) and the UI shows the final size before saving.

## 2. Analysis resolution and sampling kernels

Each cell is analysed on a sub-grid of `SW × SH` analysis pixels, `SW = 8`, `SH = round(SW·cellH/cellW)`, that is `round(8·k)` at the default `cellW = 8` (16 for k = 2) and keeps analysis pixels square for any other integer cell. `SH` is 13 / 16 / 20 for `lh` 1.0 / 1.2 / 1.5 with the bundled fonts. The source is resampled once to an analysis image of `cols·SW × rows·SH` with an area (box) filter: on the GPU by sampling the mipmapped source with `textureLod` at the matching level plus a small tap grid; on the CPU by box-averaging. Never upsample on the CPU.

Sampling circles are defined in cell-normalised coordinates: `x` in units of cell width, `y` in units of cell height, radius `r` in units of cell **width**. The layout is 180°-rotation symmetric (`(x, y) → (1−x, 1−y)` maps the set onto itself), so the matcher has no up/down or left/right bias.

Internal circles (radius 0.30):

| # | x | y | position |
|---|---|---|---|
| I0 | 0.29 | 0.21 | top-left |
| I1 | 0.71 | 0.16 | top-right |
| I2 | 0.29 | 0.52 | middle-left |
| I3 | 0.71 | 0.48 | middle-right |
| I4 | 0.29 | 0.84 | bottom-left |
| I5 | 0.71 | 0.79 | bottom-right |

External circles (radius 0.25), reaching into neighbouring cells:

| # | x | y | | # | x | y |
|---|---|---|---|---|---|---|
| E0 | 0.29 | −0.15 | above I0 | E5 | 1.30 | 0.48 | right of I3 |
| E1 | 0.71 | −0.15 | above I1 | E6 | −0.30 | 0.84 | left of I4 |
| E2 | −0.30 | 0.21 | left of I0 | E7 | 1.30 | 0.79 | right of I5 |
| E3 | 1.30 | 0.16 | right of I1 | E8 | 0.29 | 1.15 | below I4 |
| E4 | −0.30 | 0.52 | left of I2 | E9 | 0.71 | 1.15 | below I5 |

Affecting sets (which externals sharpen which internal): `I0 {E0,E1,E2}`, `I1 {E0,E1,E3}`, `I2 {E4}`, `I3 {E5}`, `I4 {E8,E9,E6}`, `I5 {E8,E9,E7}`.

**Exact area-weighted kernels.** For each circle, precompute a *tap table*: the analysis pixels `(dx, dy)` (relative to the cell's top-left analysis pixel, possibly negative or ≥ SW/SH for externals) with weight = fraction of that pixel's area inside the circle (8×8 supersampling per pixel is enough), normalised so weights sum to 1. Internal circle taps are restricted to inside the cell (taps outside are dropped and the rest renormalised) so that glyph tiles and image cells are sampled identically. External taps read neighbouring cells and clamp to the image edge.

The **same tap tables** are used for the image and for building glyph vectors. (The original used 64 point samples for the image and 256 for glyphs, so glyphs did not even match themselves.)

## 3. Tone (before matching)

Per analysis pixel, from the area-averaged premultiplied luma `Lp = Σ w·a·L` and alpha `a = Σ w·a` (sRGB-encoded values in 0..1, no linearisation; `L = 0.2126 R + 0.7152 G + 0.0722 B`):

```
if (a == 0) T = 0                                               // fully transparent: paper
L     = Lp / a                                                  // the visible colour's luma (un-premultiplied)
L     = clamp((L − black) / max(white − black, 1e-3), 0, 1)     // levels; black/white from auto-levels or 0/1
L     = clamp((L − 0.5)·contrast + 0.5 + brightness, 0, 1)     // contrast 0.5..2 (1 = off), brightness −0.5..0.5
L     = L ^ gamma                                               // gamma 0.4..2.5
if (polarityInvert) L = 1 − L
T     = a · L                                                   // the pixel's tone: amount of ink
```

`polarityInvert = params.invert XOR (luma(ink) < luma(paper))`: tone always stands for *ink*, so dark ink on light paper matches darkness, not lightness.

**Transparency is composited in tone space** (amended 2026-10-04). Tone 0 is paper in both polarities, so scaling the visible colour's tone by alpha makes transparent pixels paper under any paper colour, levels, brightness, contrast, gamma or Invert, and a half-transparent edge gets half the ink of its colour. (The original mixed the paper's luma into `L` *before* the tone curve, so a transparent area was "paper-coloured image content": on light paper, at brightness +0.2, at contrast 0.6 or with Invert it filled with `.` `:` `$`, and a black icon on transparency rendered as a hole in a wall of `|`.) The colour pass (§7) still composites colours over the paper colour, which is what a transparent cell shows.

**Auto-levels** (default on): `black = p1`, `white = p99` of luminance, computed once per still image from a ≤ 256 px downsample, once per GIF/video clip (from ~8 frames spread across it). Never per frame, and never from the max pixel (the original divided every frame by its own maximum: one bright pixel re-exposed the whole image and caused frame-to-frame flicker). Details (`measureLevels`):

- Only visible pixels count (downsampled alpha ≥ 0.5, luminance un-premultiplied): transparent areas show the paper and are not part of the image's exposure.
- Percentiles are read symmetrically from the sorted values (`v[i]` and `v[n−1−i]`, `i = round(0.01·(n−1))`), so an image's negative gets exactly the mirrored levels.
- **Levels clip tails, never populations.** When a percentile lands on a flat tone (at least 2 % of the visible pixels, twice the clip, within ±2/255 of it), that end is left unstretched (`black = 0`, or `white = 1`), unless the flat tone reads as background: at the black point a tone darker than 0.25·white may still become paper (a dark backdrop vanishing is what auto-levels is for), mirrored at the white point (`1 − white < 0.25·(1 − black)`). Without this a graphic's darker colour sits exactly on p1 and is mapped to tone 0: a white logo with a #1E90FF bar measured `{0.50, 1}` and the bar vanished in every mode, Source colour included. A flat image is the same case at both ends and keeps its own level.
- If `white − black < 0.1` the range is widened to 0.1, placed so the image's own level maps to itself (`black = mid·0.9`): a nearly flat continuous image is not blown out to pure black or white.
- With `autoLevels` off the levels are `black = 0, white = 1`, whatever was measured.

## 4. Glyph vectors

For the selected font and charset (deduplicated; unsupported glyphs dropped), rasterise each glyph at its natural baseline position into a cell tile of exactly `SW·4 × SH·4` px (4× supersampled, then area-downsampled to `SW × SH` coverage), white on black, using the §1 geometry scaled to that tile (font size `fontSize·4SW/cellW`, baseline `baseline·4SH/cellH`, drawn through the one canonical `drawGlyph`). Then for each glyph `g`:

```
v[g][k] = Σ taps w · coverage          for the 6 internal circles
ĝ[g][k] = v[g][k] / max_g v[g][k]      // normalise PER COMPONENT (guard zero columns)
W       = max_g mean_k ĝ[g][k]         // white-point anchor (measured: 0.83 for printable ASCII in JetBrains Mono, 0.82–0.84 across the bundled fonts; '$' sets it)
```

Dedupe glyphs whose normalised vectors are within 1e-3 (Euclidean; keep the first). The space glyph must be present (vector 0). A glyph is dropped as unsupported when its tile is byte-identical to the missing-glyph rendering of U+10FFFD, when its advance differs from the font's by more than 0.1 % (a fallback font drew it), or when drawing it with `family, serif` and `family, monospace` gives different pixels (the generic fallback was used). Glyphs without any ink (other than the space) are dropped too. In the printable-ASCII, minimal, lines and dense presets nothing is dropped in any bundled font.

Charset presets (`src/engine/charsets.ts`): `ascii` = printable U+0020–U+007E (95); `minimal` = `` .:-=+*#%@`` (a short tonal ramp); `lines` = `` .'`,-_|/\`` (strokes only); `dense` = ASCII plus 50 Latin-1 / punctuation symbols present in all bundled fonts (145). Custom sets are split into code points, deduplicated, stripped of control / format / non-space whitespace characters, capped at 256, and fall back to ASCII when nothing visible is left. The space always comes first.

## 5. Shape matching (mode `shape`)

Per cell:

```
q[k]  (k = 0..5)  = Σ taps w · L     internal circle means
e[j]  (j = 0..9)  = Σ taps w · L     external circle means

// global contrast ("shape sharpness", default 1.5, range 1..4)
m = max_k q[k];  if m > 0: q[k] = (q[k] / m)^G · m

// directional contrast ("edge sharpness", default 1.75, range 1..4)
for k: M = max(q[k], max_{j in A(k)} e[j]);  if M > 0: q[k] = (q[k] / M)^D · M

// dither (cell-locked, never time-varying): amount default 0.05, range 0..0.5
n    = blueNoise64(col, row)                                          // the 64×64 tile of §6
q[k] = q[k] + (n − 0.5) · min(amount, 2·q[k], 2·(1 − q[k]))

// white-point anchor, then exact nearest neighbour (no cache, no k-d tree)
q'[k] = q[k] · W
m     = mean_k q'[k];   r[k] = q'[k] − m                  // the cell's tone and shape
s     = clamp(|r| / 0.3, 0.2, 1)                         // |r| = sqrt(Σ r²): how much shape the cell has
d(g)  = 6·(m − μ_g)² + s · Σ_k (r[k] − ρ_g[k])²            // μ_g = mean_k ĝ[g][k],  ρ_g = ĝ[g] − μ_g
glyph = argmin_g d(g)                                     ties -> lowest index
```

**Structure-weighted distance** (amended 2026-10-04 after rendering the fixtures). For `s = 1` this *is* the plain squared distance `Σ (q' − ĝ)²`, because that distance splits exactly into `6·Δmean² + |Δshape|²`; cells with real structure (an edge gives `|r|` ≈ 0.5–1) are matched exactly as before. With the plain distance, a flat cell (`r = 0`) pays the full shape energy `|ρ_g|²` of every glyph, so only the few glyphs whose six circle values happen to be uniform can win: in JetBrains Mono a flat input ramps through just 11 glyphs (`` ' ! | U S O 0 8 @ $``), `'!'` alone covers lightness 0.22–0.45, and everything below 0.15 renders as space. Measured at the defaults (160 columns): `'!'` on 61 % of the inked cells of the terrain fixture and 48 % of the waves fixture, the dark half of the torus blank. Weighting the shape term by the cell's own structure (never below 0.2, so strongly shaped glyphs stay out of flat areas) gives `'!'` 35 % on terrain, inks the torus's dark side, a flat ramp of 14 glyphs with ink from lightness 0.09, while edges keep their `/ \ _ |` glyphs. Across all three fonts × lh {1.0, 1.2, 1.5} the most common glyph on torus / terrain / waves drops from up to 61 % to at most 36 %. The constants are `SHAPE_TAU = 0.3`, `SHAPE_MIN = 0.2` in `src/engine/match.ts`; the GPU uploads `μ_g` and `ρ_g` (`glyphResiduals`) and evaluates the same formula.

**Tone dither** (amended 2026-10-04). The amplitude is limited to `2·min(q, 1 − q)`, so `q ± offset` never leaves [0, 1]: nothing is clipped, the dither adds no ink on average, and exact black and white stay exact. (Clipping a symmetric offset at 0 adds ink: with the Soft photo preset's 0.15, 3 of 16 cells over a pure-black background got a `.`, a visible 4×4 lattice.) The noise is the blue-noise tile instead of the 4×4 Bayer matrix: Bayer's strong period-2 component alternates neighbouring glyphs into regular hatching across smooth gradients (`V|V|`, `UXUX`, `$@$@`). Measured over 8 images at 160 columns, blue noise halves the share of horizontal `a b a` triples at every amount with the same banding (cells in runs of 8+) and tone fidelity; the default amount drops from 0.10 to 0.05, which cuts that share on the gradient fixture from 0.54 to 0.15 (photos 0.37–0.52 → 0.13–0.18) while still breaking smooth areas into grain rather than flat bands.

Brute force over ≤ 256 glyphs is exact, deterministic and cheap (≈ 1.5 k FLOPs per cell). The original's 5-bit quantised cache returned the wrong glyph for 5–32 % of cells and depended on scan order.

## 5b. Edge layer (shape and ramp, `edges`)

After Acerola's ASCII shader: contour strokes where the image has a strong, straight edge, the fill glyph everywhere else. Computed at analysis resolution from the tone image `T` of §3 (`src/engine/edges.ts`; the GPU runs the same kernels in passes `edge-blur` / `edge-dog` and the cell pass).

```
D      = G(σ)∗T − G(1.6σ)∗T              σ = 1.5 analysis px; separable, kernels w[i] ∝ exp(−i²/2σ²) for |i| ≤ ceil(3·1.6σ), normalised; edges clamped
(gx,gy)= Sobel(D) at every analysis pixel of the cell (neighbours clamped to the image)
m      = sqrt(gx² + gy²)
bin    = '|'  if |gy| ≤ tan(β/2)·|gx|                 β = atan(SW/SH): gradient angle of a '/' spanning the cell diagonal
         '-'  if |gy| ≥ tan((β + 90°)/2)·|gx|
         '/'  if gx·gy > 0, else '\'                  (image y points down)
E[bin] += m;   for '-' also accumulate m·(y + 0.5)
b*     = argmax E (first on ties);  stroke = '_' if b* = '-' and the weighted row centre > split·SH
edge   ⇔ E[b*] ≥ 0.6·ΣE  and  E[b*] / (P·chord(b*)) ≥ 0.6·edgeThreshold − keep
```

- The difference of Gaussians is a band-pass: smooth shading and gradients give no response, edges and thin lines do. σ = 1.5 keeps object outlines and line art and ignores fine photographic texture (σ = 1 drew rooftops and foliage as `-` carpets; 2 adds nothing but moves outlines a cell outwards).
- **Bins follow the cell aspect.** A `/` in an 8 × 16 cell rises at 63° (the cell diagonal), not 45°; bin boundaries lie halfway in angle between the strokes' own directions, so lines steeper than 77° read `|`, flatter than 32° read `-`, and 45° / 135° lines read `/` / `\`.
- **Strength ≈ the edge's tone contrast.** `P` is the Sobel magnitude summed across a unit step edge (computed once with the same code); `chord` is the length of the stroke through the cell (SH for `|`, SW for `-`, the diagonal for `/` `\`). A full-contrast edge through the cell centre scores 1. `edgeThreshold` 0..1 maps linearly to strength 0..0.6 (default 0.5 → contrast 0.3). Texture spreads its energy over the bins and fails the 0.6 dominance test.
- `split` (`GlyphSet.lowStrokeSplit`) is halfway between the ink centres of `-` and `_` in the current font and cell.
- The strokes are always drawable: `GlyphSet.atlasChars` is the matchable charset followed by any of `| / \ - _` it lacks (grid indices of shape / ramp cells index `atlasChars`).
- §8: a cell that showed this stroke last frame keeps it down to `threshold − stability·0.05`.
- Edges off leaves every cell exactly as before; with edges on a cell is either its fill glyph or a stroke.

## 6. Other modes

All modes write the same per-cell outputs: glyph index (→ character), an auxiliary value (tone/coverage), and the cell's mean source colour.

- **ramp**: characters sorted by mean normalised coverage (§4), `t = dither(L̄)·W_r` with the §5 tone dither; pick the glyph whose mean coverage is nearest `t` (ties → lowest glyph index). `L̄` = cell mean of the tone-mapped lightness. The edge layer (§5b) applies as in shape mode.
  - Candidates (`GlyphSet.rampGlyphs`): every glyph, except for the presets made for shape matching (`ascii`, `dense`), where ramp uses only the space and the `minimal` ramp's characters `` .:-=+*#%@`` (`charsets.ts rampCharset`; all glyphs if the font has fewer than two of them). Matching tone alone against 95+ glyphs picks neighbouring letters whose coverage differs by less than dither or codec noise, which reads as random text and boils on video. `W_r` (`rampAnchor`) is the largest mean coverage among the candidates, so full ink maps to the densest candidate. The §8 keep rule only keeps a previous glyph that is a candidate. The GPU flags candidates in the `Glyphs` block (`(ρ3, ρ4, ρ5, ramp)`).
  - The compare view's ramp render (§8b) uses the same candidates, so "vs Ramp" shows the classic ramp rather than letter noise.
- **braille**: 2×4 dots per cell. Dot `(dx, dy)` lightness = mean over its `SW/2 × SH/4` analysis pixels. Threshold: `none` → 0.5; `ordered` → Bayer 8×8 at the global dot coordinate `(2·col+dx, 4·row+dy)`; `noise` → a tiled 64×64 blue-noise texture (Ulichney void-and-cluster, σ = 1.5, built deterministically at first use: `blueNoise64()`). A dot is set when its lightness is strictly greater than the threshold. When `SH` is not a multiple of 4 (lh 1.0 → 13) the dot rectangles use fractional pixel weights so all eight stay equal in area. Bits: `(0,0)=0x01 (0,1)=0x02 (0,2)=0x04 (1,0)=0x08 (1,1)=0x10 (1,2)=0x20 (0,3)=0x40 (1,3)=0x80` (dx = column, dy = row). Character `U+2800 + bits`. Drawn procedurally (anti-aliased discs at the sub-cell centres, radius `0.36·min(cellW/2, cellH/4)`), so no font is needed and dots stay sharp at any scale.
- **blocks**: 2×2 quadrants. Mono: threshold each quadrant like braille (ordered/noise/none) → 4 bits (TL=1, TR=2, BL=4, BR=8) → ` ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█` (index = bits). Colour mode (`colorMode = source`): try all 16 partitions, set fg/bg to the mean colour of the on/off quadrants, keep the partition with least squared error (two colours per cell; complementary partitions tie, so the 8 representatives `0..7` are tried, ties → lowest, where errors within `1e-9` count as ties so rounding noise in flat areas never picks a partition). The *on* side is then the one with the higher mean tone (the inkier side; tones within `1e-6` keep the lowest mask), and a single-colour cell is `█` if its mean tone is > 0.5, else space, so the text form of a colour render matches the mono one. Drawn procedurally as rectangles.
- **halftone**: not glyph-based. A dot lattice with pitch `cellW` rotated by `halftoneAngle` (default 45°). For each output pixel, consider the nearest lattice point and its 8 neighbours; each dot's coverage `c` is the tone-mapped lightness sampled at its centre (mip level ≈ pitch); dot radius `r = pitch·sqrt(c/π)` for round dots (square / diamond / line shapes use the matching distance function with equal area); anti-alias with `fwidth`. Output size is identical to the text modes for the same `cols`. TXT/HTML export map the per-cell coverage `c` to the ramp ` ·•●` at index `round(3c)`. SVG emits `<circle>`s.

## 7. Colour

- `mono`: every glyph in `ink` on `paper`.
- `source`: glyph colour = the cell's mean source colour, brightened so its largest channel is 1 (`rgb / max(maxChannel, 0.25)`), on `paper` (blocks: two colours per cell, no paper).
- `duotone`: glyph colour = `mix(shadowInk, ink, smoothstep(0, 1, √L̄))`, on `paper`. (Amended 2026-10-04: with `smoothstep(L̄)` a dark cell was darkened twice (sparse glyph *and* shadow colour), so low-key photos showed ~40 % of Mono's light; the square root lifts the weight, +40–50 % displayed light on low-key images, while the darkest cells keep the shadow colour.)

## 8. Video stability (GIF / video only)

`stability ∈ [0, 1]` (default 0.5). Per cell, keep the previous frame's filtered vector `q̃` and glyph `p`:

```
α  = mix(1, 0.3, stability);  Δ = max_k |q[k] − q̃[k]|
α' = max(α, clamp(Δ · 4, 0, 1))          // big changes (cuts, motion) pass through immediately
q̃ = mix(q̃, q, α')                        // match on q̃ instead of q
keep p unless  d(best) < d(p) − stability · 0.02
```

Other modes filter their own feature vector the same way (ramp and halftone: the cell tone; braille: the 8 dot means; blocks: the 4 quadrant means) before deciding; ramp also applies the keep rule with `d = |t − μ_g|`. The keep rule only considers a previous glyph that is matchable (an edge stroke added outside the charset is not).

**Thresholded modes keep their state too** (amended 2026-10-04). Smoothing alone left braille changing 2–5 % and blocks 1–2 % of cells per frame on static noisy footage, at any stability. With history, the previous frame's bits add hysteresis:

```
band  = stability · 0.05
shift = min(band, t/2, (1 − t)/2)                  // never moves a threshold t out of (0, 1)
dot on   iff  v > t − shift   (it was on)
         iff  v > t + shift   (it was off)
```

The shift shrinks near the ends so pure white and black dots are decided by the image alone. Blocks colour mode keeps the previous partition while its error is within `stability · 0.01` of the best (never over a single-colour best fit: an invisible split would only change the character), and its orientation (which side is on, or █ / space for one colour) while the deciding tones differ by less than `band`. On a static noisy clip at the default 0.5 this takes braille from 5.2 % to 0.03 %, blocks from 2.2 % to 0.00 % and colour blocks from 81 % to 0.00 % of cells changing per frame, while a cut still passes within a frame. The edge layer keeps a stroke the same way (§5b).

The CPU reference applies §8 only when it is given a history object (one per clip), which resets itself when the mode, grid size or glyph set changes. History resets when the source changes or playback seeks. Dither patterns are screen-locked (never time-varying). Error-diffusion dithering (if added later) is for stills only.

## 8b. Preview, readback and the GPU

- **Minified preview.** Below zoom 0.75 (a device pixel spans more than 1.33 output px) the grid is composed at scale 1 (exactly the 1× export) into an offscreen texture and box-filtered onto the canvas: each canvas pixel is the area average of the export under it (mip levels keep the footprint within 4 texels). Trilinear sampling of the 4× glyph atlas blurred small glyphs into illegible row bands, and point-sampled halftone dots beat against the pixel grid; the box filter is the 1× export's own appearance at that size (checked to ±1 of a 2 × 2 box average at zoom 0.5). Integer zooms still read the atlas built at that scale texel for texel (preview = export); other zooms sample the 4–16× atlas trilinearly, which is already sharp at 0.75 and above and saves the extra pass.
- **Compare with ramp.** With `Viewport.compareWith = 'ramp'` the left of the split shows the same source analysed in ramp mode with the current charset, tone and colour (edges off), from a second set of cell targets with its own §8 history.
- **Readback.** `readRaster` composes every export tile at call time and queues its readback into pixel-pack buffers (rows placed with `PACK_ROW_LENGTH`; a reused buffer's storage is re-specified first, so Chrome never warns about rewriting a fenced READ buffer), then polls a fence without blocking; rasters over 64 MB are read in batches, all composed from a copy of the cell texture and the params taken at the call, so edits, new frames or a closed file in between cannot mix two pictures (only a font / charset / line-height change, which replaces the glyph atlases, rejects the call). `probe` answers from an asynchronous readback of the cell texture, one per analysed frame, marked `pending` until it arrives.
- **Programs.** The sub-cell size and every tap table (§2 circles, §6 dots and quadrants) reach the cell shaders through a uniform block, so one program per mode serves every font and line height (no recompiles while dragging Line height); a pass-2 program specialised for the current sub-cell size replaces it once compiled, a compile started only after the geometry has stopped changing for 400 ms (a GPU-process compile delays synchronous GL calls behind it). `warmup()` compiles all programs in the background with `KHR_parallel_shader_compile`, starting when the engine is created (during start-screen idle time), current mode first. Framebuffer completeness is checked once per context for each attachment layout, never per allocation.

## 9. Determinism and tests

Same still input + same params ⇒ byte-identical grid. Required regression tests (CPU reference, `tests/engine/*.test.ts`, glyphs rasterised with `@napi-rs/canvas` and the bundled fonts):

1. **Round trip:** random printable text drawn in the atlas font at baseline, analysed with contrast/sharpness 1, dither 0, levels off ⇒ ≥ 98 % of characters recovered. Drawn at the atlas resolution (export scale 4) and compared in glyph space (`q[k] / max_g v[g][k]`, no anchor: in tone space a drawn glyph is just a grey patch) the recovery is 100 %; at scale 2 it is ≈ 95 % and at scale 1 ≈ 57 %, because text rasterised at 13 px is hinted and stem-darkened (heavier, pixel-snapped strokes), which no analysis can undo.
2. **Ramp:** a horizontal 0→1 gradient ⇒ displayed ink (mean coverage of chosen glyphs per column) non-decreasing within a 0.02 tolerance, ≥ 7 distinct glyphs, no glyph on more than 35 % of columns.
3. **Locality:** adding a small bright patch (levels off) changes no cell more than 2 cells away from it.
4. **Determinism:** two runs give identical grids.
5. **Geometry:** for fonts × `lh` × cols × scales, output aspect matches the source within `0.5/rows`; raster size equals `cols·cellW·s × rows·cellH·s`.
6. **Modes:** braille bit order and characters; blocks table; halftone coverage monotone in lightness.
7. **Polarity:** dark ink on light paper renders a dark-on-light image as the same glyph pattern as its negative with light ink on dark paper.
8. **Transparency:** a fully transparent pixel has tone 0 under any paper, levels, brightness, contrast, gamma and Invert; a flat colour of a graphic is never levelled into paper.
9. **Edges:** synthetic lines at 0 / 45 / 90 / 135° become `-` / `/` / `|` / `\` (≥ 80 % of the cells on the line, no strokes away from it), a low horizontal edge becomes `_`, slopes bin by the cell aspect, edges off leaves the grid untouched.
10. **Stability:** braille and blocks on a static noisy clip change < 0.2 % of cells per frame at the default stability (≥ 5× fewer than without history), and a cut passes within two frames.

The GPU is checked against the CPU reference in Chrome (`tests/e2e/engine.spec.ts`): fed the GPU's own analysis image the grids agree on every cell for every mode, the edge layer and §8 history; plus readRaster = renderRaster, the probe, GPU timings, warmup, releaseSource, compare with ramp and the minified preview.

Also covered (`tests/engine/`): tap weights sum to 1 and the tap tables are exactly 180° symmetric; `-`, `_` and `.` get distinct vectors in the right circle rows; the torus and terrain fixtures put no glyph on more than 40 % of the inked cells, and the terrain's sun gets more ink than the sky around it; stability damps noise flicker but lets cuts through; a 160 × 90 analysis takes < 60 ms in Node. `CONTACT_SHEET_DIR=… npx vitest run tests/engine/contact-sheet.test.ts` renders the fixtures in every mode to PNG for eyeballing.
