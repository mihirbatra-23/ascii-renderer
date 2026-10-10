# Case study assets

Screenshots and renders for the portfolio case study about ASCII Renderer. Nothing in this folder is used by the app.

Everything here was captured on 5 October 2026 from the code in this repository: the current app (the same build as https://asciirenderer.vercel.app/) running locally, and the Python version in `legacy/` running under Flask. Screens are 1440 × 900 at 2× unless noted.

The browser used for capture renders WebGL on the CPU (SwiftShader), so the render times in the status bar of the `new-*` screenshots are much slower than on a real GPU. Crop the status bar or recapture on your own machine if the timing shows.

## v0 (Python, `legacy/`)

| File | What it shows |
| --- | --- |
| `legacy-01-empty.png` | The Flask page before a file is dropped |
| `legacy-02-torus-text.png` | The torus sample rendered, Text tab, with the cache hit rate under the buttons |
| `legacy-03-torus-image.png` | The same render, Image tab |
| `legacy-02-triangle-text.png`, `legacy-03-triangle-image.png` | The repo's own test image, both tabs |
| `legacy-output-torus.png`, `legacy-output-triangle.png` | v0's raw PNG output (note the squashed aspect) |
| `legacy-output-*.txt` | v0's raw text output |

## v1 (the current app)

| File | What it shows |
| --- | --- |
| `new-01-start.png` | Start screen |
| `new-02-editor-shape.png` | Editor, torus in Shape mode |
| `new-03-split-vs-source.png` | Split view against the original |
| `new-04-split-vs-ramp.png` | Split view against a plain Ramp render |
| `new-05-mode-*.png` | The torus in each of the five modes |
| `look-*.png` | The same five renders cropped to the torus (1300 × 1010), one image per look |
| `new-06-edges-on.png` | Contour lines (edge layer) on |
| `new-07-export-panel.png` | Export panel |
| `new-08-planet-source-color.png` | Planet sample in Source colour |
| `new-09-video.png`, `new-09b-video-braille.png` | Video playback in Shape and Braille, with the timeline |
| `new-10-camera-fake-feed.png` | Camera mode, fed by Chrome's built-in fake test camera. Replace with a real webcam capture |
| `new-11-phone-start.png`, `new-12-phone-editor.png` | Phone layout, 390 × 844 at 3× |
| `new-13-shortcuts.png` | The keyboard shortcuts sheet over the editor |
| `new-output-*.png`, `new-output-*.txt` | PNG and TXT exports from the app, in mono, for comparisons |
| `anim-interference-shape.gif`, `anim-interference-shape.webm` | Animated exports of the video sample in Shape mode, 1280 × 720 |

## Composites

| File | What it shows |
| --- | --- |
| `compare-torus-v0-vs-v1.png` | v0 and v1 output of the torus at 120 columns, side by side |
| `compare-triangle-ramp-vs-shape.png` | Ramp and Shape zoomed in on the triangle's edge |
| `compare-triangle-ramp-vs-shape-full.png` | The same pair, uncropped |
| `modes-strip.png` | The torus in all five modes in one strip |
| `design-overview.png` | The full interface in one image: start screen, editor, export panel, shortcuts sheet and phone layout |

## Illustrations

Drawn from the CPU reference renderer's own data (Geist Mono, line height 1.2), in the app's colours.

| File | What it shows |
| --- | --- |
| `figure-character-fingerprints.png` | Eight characters with the six sampling circles, each filled by the ink it covers, with the values underneath |
| `figure-reading-and-matching.png` | The rim of the test image's white circle at 80 columns: the cells, the six readings per cell, the characters picked by shape, and the brightness-only picks |

The video sample was transcoded to WebM for capture, because the test browser cannot decode H.264. The app itself plays the MP4 in any browser that supports H.264, such as Chrome.

## Portfolio export

`portfolio-export/` holds the final draft of the case study (Draft 4 in the doc) as one markdown file, `ascii-renderer.md`, for building the page on the portfolio. Page details (title, year, description, role, timeline, tools, links, thumbnail) are in its frontmatter. The cover is Mihir's own looping animation and isn't included.

Things the page still needs are left as HTML comments in the markdown: three images to add (Cognition's old homepage animation, the Figma hero section variant, the Claude Design canvas) and the interactive mode switcher in "Five modes and colour".

`assets/` holds every image the page uses, exactly as it appears in the doc:

| File | What it shows |
| --- | --- |
| `initial-build.png` | The initial build (the Python app in `legacy/`) after rendering a torus |
| `max-plan-limit.png` | The Claude usage page with the weekly limit hit (Mihir's screenshot) |
| `initial-vs-new-torus.png` | The torus at 120 columns in the initial build and the new app |
| `start-screen.png` | The new start screen |
| `editor.png` | The editor with the torus in Shape mode (also the thumbnail) |
| `cell-probe.png` | Hovering over a cell on the torus's top edge |
| `split-view.png` | Split view against the source |
| `video-playback.png` | A looping video with the timeline and filmstrip |
| `mode-*.png` | A gradient torus in each of the five modes at 110 columns, in Mono (2× PNG exports from the app) |
| `colour-mono.png`, `colour-source.png`, `colour-duotone.png` | The same torus in each colour theme (Duotone with violet shadow ink and yellow ink). `colour-mono.png` is the same image as `mode-shape.png` |
| `export-panel.png` | The export panel |
| `shortcuts-sheet.png` | The keyboard shortcuts sheet, with nothing focused |
| `reading-and-matching.png` | The illustration of reading cells and matching characters |

The gradient torus is a 3D render made for the case study, kept in `assets/gradient-torus.png`. Screenshots of the editor show slow render times in the status bar because the capture browser drew WebGL on the CPU.
