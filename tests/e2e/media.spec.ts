/**
 * Media decoding and playback in real Chrome, through the dev harness (dev/media.html).
 * Corpus tests read local-only files (not in the repo) and are skipped when the corpus is absent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Harness } from '../../dev/media';

declare global {
  interface Window {
    harness: Harness;
  }
}

const CORPUS =
  process.env.MEDIA_CORPUS_DIR ??
  process.env.ASCII_CORPUS_DIR ?? '';
const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const fixture = (name: string) => `/tests/fixtures/${name}`;
const local = (name: string) => `/tests/media/fixtures/${name}`;
const corpus = (path: string) => `/__corpus__/${path}`;
const hasCorpus = existsSync(CORPUS);

/** testsrc2_4s.mp4 with its video track matrix set to a 90° rotation (as phones record portrait). */
function rotatedMp4(): Buffer {
  const mp4 = Buffer.from(readFileSync(join(FIXTURES, 'testsrc2_4s.mp4')));
  const at = mp4.indexOf('tkhd');
  const version = mp4[at + 4];
  const matrix = at + 8 + (version === 1 ? 32 : 20) + 16;
  [0, 0x00010000, 0, 0xffff0000, 0, 0, 0, 0, 0x40000000].forEach((v, i) => mp4.writeUInt32BE(v, matrix + 4 * i));
  return mp4;
}

let pageErrors: Error[] = [];

/** testsrc2_4s.mp4 with its sample entry renamed to a codec no browser knows. */
function unplayableMp4(): Buffer {
  const mp4 = Buffer.from(readFileSync(join(FIXTURES, 'testsrc2_4s.mp4')));
  mp4.write('zzzz', mp4.indexOf('avc1', mp4.indexOf('stsd')));
  return mp4;
}

async function openHarness(page: Page): Promise<void> {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await page.route('**/__corpus__/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.replace('/__corpus__/', ''));
    return route.fulfill({ body: readFileSync(join(CORPUS, path)) });
  });
  await page.route('**/__generated__/rotated90.mp4', (route) => route.fulfill({ body: rotatedMp4() }));
  await page.route('**/__generated__/unplayable.mp4', (route) => route.fulfill({ body: unplayableMp4() }));
  await page.goto('/dev/media.html');
  await page.waitForFunction(() => window.harness !== undefined);
}

const open = (page: Page, url: string) => page.evaluate((u) => window.harness.open(u), url);
const loadError = (page: Page, url: string) => page.evaluate((u) => window.harness.loadError(u), url);

test.beforeEach(async ({ page }) => openHarness(page));
test.afterEach(() => expect(pageErrors.map(String)).toEqual([]));

test.describe('images', () => {
  test('EXIF orientation 6 is applied: stored 480×270 displays as 270×480', async ({ page }) => {
    expect(await open(page, fixture('exif6_480x270.jpg'))).toMatchObject({
      kind: 'image',
      width: 270,
      height: 480,
      formatLabel: 'JPEG',
      hasAlpha: false,
    });
  });

  test('16-bit PNG is not clipped: same mean luma as the 8-bit original', async ({ page }) => {
    const [gray16, torus] = await page.evaluate(async () => {
      const h = window.harness;
      const stats = async (url: string) => {
        const media = await h.loadMedia(await (await fetch(url)).blob());
        if (media.kind !== 'image') throw new Error(media.kind);
        return h.frameStats(media.bitmap);
      };
      return [await stats('/tests/fixtures/gray16_200.png'), await stats('/tests/fixtures/torus_450.png')];
    });
    // Pillow reference: gray16 mean 7982.8 / 65535 = 0.1218; torus mean 31.02 / 255 = 0.1217.
    expect(gray16.meanLuma).toBeCloseTo(0.1218, 2);
    expect(torus.meanLuma).toBeCloseTo(0.1217, 2);
    expect(gray16.transparentFraction).toBe(0);
  });

  test('alpha is detected only where it exists', async ({ page }) => {
    expect((await open(page, fixture('logo_rgba_256.png'))).hasAlpha).toBe(true);
    expect((await open(page, fixture('torus_450.png'))).hasAlpha).toBe(false);
    expect((await open(page, fixture('gradient_512x64.png'))).hasAlpha).toBe(false);
  });

  test('WebP, AVIF, BMP and ICO stills decode', async ({ page }) => {
    expect(await open(page, local('still_lossy.webp'))).toMatchObject({ kind: 'image', width: 64, height: 48, formatLabel: 'WebP', hasAlpha: false });
    expect(await open(page, local('still_alpha_lossless.webp'))).toMatchObject({ kind: 'image', width: 64, height: 48, hasAlpha: true });
    expect(await open(page, local('still.avif'))).toMatchObject({ kind: 'image', width: 64, height: 48, formatLabel: 'AVIF' });
    expect(await open(page, local('still.bmp'))).toMatchObject({ kind: 'image', width: 64, height: 48, formatLabel: 'BMP', hasAlpha: false });
    expect(await open(page, local('icon.ico'))).toMatchObject({ kind: 'image', width: 48, height: 36, formatLabel: 'ICO', hasAlpha: true });
  });

  test('SVG is rasterised at its viewBox aspect, 2048 px on the long side, with alpha', async ({ page }) => {
    const summary = await open(page, local('badge.svg'));
    expect(summary).toMatchObject({ kind: 'image', width: 2048, height: 1024, formatLabel: 'SVG', hasAlpha: true });
    const stats = await page.evaluate(() => {
      const media = window.harness.media;
      if (media?.kind !== 'image') throw new Error('not an image');
      return window.harness.frameStats(media.bitmap);
    });
    // The rounded rect covers ~(180×80)/(200×100) of the canvas; the corners stay transparent.
    expect(stats.transparentFraction).toBeGreaterThan(0.2);
    expect(stats.transparentFraction).toBeLessThan(0.35);
  });

  test('a large still is analysed through a ≤ 512 px thumbnail, never the full bitmap', async ({ page }) => {
    const r = await page.evaluate(() => window.harness.bigStill(6000));
    console.log('big still', JSON.stringify(r));
    expect(r.size).toEqual([6000, 6000]);
    expect(r.thumbnail).toEqual([512, 512]);
    expect(r.levelsSnapshot).toEqual([[256, 256]]);
  });

  test('HEIC decodes natively where supported, otherwise fails with heic-unsupported', async ({ page }) => {
    const error = await loadError(page, local('still.heic'));
    if (error) {
      expect(error.code).toBe('heic-unsupported');
      expect(error.message).toMatch(/JPEG or PNG/);
    } else {
      expect(await open(page, local('still.heic'))).toMatchObject({ kind: 'image', width: 64, height: 48, formatLabel: 'HEIC' });
    }
  });

  test('errors are MediaErrors with readable messages', async ({ page }) => {
    const errors = await page.evaluate(async () => {
      const h = window.harness;
      const attempt = async (blob: Blob) => {
        try {
          await h.loadMedia(blob, 'x');
          return null;
        } catch (error) {
          return h.isMediaError(error) ? error.code : String(error);
        }
      };
      return {
        empty: await attempt(new Blob([])),
        text: await attempt(new Blob(['just some text, not media'])),
        truncatedPng: await attempt((await (await fetch('/tests/fixtures/torus_450.png')).blob()).slice(0, 200)),
        audioOnly: await attempt(await h.audioOnlyMp4()),
      };
    });
    // A known container without a picture is a damaged / audio-only file, not an unknown type.
    expect(errors).toEqual({ empty: 'empty-file', text: 'unsupported-format', truncatedPng: 'decode-failed', audioOnly: 'decode-failed' });
  });
});

test.describe('animations', () => {
  test('transparent_variable_duration.gif: 24 frames, 120/40 ms, alpha, loops forever', async ({ page }) => {
    const summary = await open(page, fixture('transparent_variable_duration.gif'));
    expect(summary).toMatchObject({ kind: 'animation', width: 320, height: 240, frameCount: 24, loopCount: 0, hasAlpha: true, totalMs: 1920 });
    expect(summary.durations).toEqual(Array.from({ length: 24 }, (_, i) => (i % 2 ? 40 : 120)));
  });

  test('long_200_frames.gif: all 200 frames load (no truncation)', async ({ page }) => {
    const summary = await open(page, fixture('long_200_frames.gif'));
    expect(summary).toMatchObject({ frameCount: 200, totalMs: 6000, hasAlpha: false });
    const sizes = await page.evaluate(async () => {
      const media = window.harness.media;
      if (media?.kind !== 'animation') throw new Error('not an animation');
      const out: number[] = [];
      for (const i of [0, 99, 199, 3]) {
        const frame = await media.getFrame(i);
        out.push(frame.width * frame.height);
      }
      return out;
    });
    expect(sizes).toEqual([19200, 19200, 19200, 19200]);
  });

  test('GIF compositing matches Chrome’s native decoder pixel for pixel', async ({ page }) => {
    for (const url of [fixture('transparent_variable_duration.gif'), fixture('long_200_frames.gif')]) {
      const result = await page.evaluate((u) => window.harness.compareWithNativeDecoder(u), url);
      expect(result.frames, url).toBe(result.nativeFrames);
      expect(result.maxDiff, url).toBe(0);
    }
  });

  test('animated WebP, APNG and AVIF play via ImageDecoder with their own durations', async ({ page }) => {
    for (const [file, format] of [['anim_3f.webp', 'WebP'], ['anim_3f.png', 'APNG'], ['anim_3f.avif', 'AVIF']]) {
      const summary = await open(page, local(file));
      expect(summary, file).toMatchObject({ kind: 'animation', formatLabel: format, width: 64, height: 48, frameCount: 3, loopCount: 0 });
      expect(summary.durations, file).toEqual([100, 200, 300]);
    }
    expect((await open(page, local('anim_3f.webp'))).hasAlpha).toBe(true);
  });

  test('without ImageDecoder, animated WebP falls back to its first frame and says so', async ({ page }) => {
    const summary = await page.evaluate(async () => {
      const saved = Object.getOwnPropertyDescriptor(globalThis, 'ImageDecoder')!;
      Reflect.deleteProperty(globalThis, 'ImageDecoder');
      try {
        const blob = await (await fetch('/tests/media/fixtures/anim_3f.webp')).blob();
        return window.harness.summarize(await window.harness.loadMedia(blob, 'anim_3f.webp'));
      } finally {
        Object.defineProperty(globalThis, 'ImageDecoder', saved);
      }
    });
    expect(summary).toMatchObject({ kind: 'image', formatLabel: 'WebP · first frame', width: 64, height: 48, hasAlpha: true });
  });

  test('animation player: exact steps, seeks, trim and drift-free looping', async ({ page }) => {
    await open(page, fixture('transparent_variable_duration.gif'));
    const result = await page.evaluate(async () => {
      // The harness already created a player for this media; a second one would fight over it.
      const player = window.harness.player!;
      const emitted: number[] = [];
      player.onFrame((_frame, t) => emitted.push(Math.round(t * 1000)));
      await player.seek(0);
      await player.step(1);
      await player.step(1);
      await player.step(-1);
      const afterSteps = [...emitted];
      await player.seek(0.5); // inside frame 6 (480..600 ms)
      const afterSeek = emitted.at(-1);

      // Trim to 160..640 ms (frames 2..7) without looping: plays once and stops on frame 7.
      player.inPoint = 0.16;
      player.outPoint = 0.64;
      player.loop = false;
      emitted.length = 0;
      await player.seek(0.16);
      player.play();
      await new Promise((r) => setTimeout(r, 900));
      const trimmed = { emitted: [...emitted], playing: player.playing, time: player.currentTime };

      // Looping for ~2.5 clip lengths: playback time stays in sync with the wall clock.
      player.inPoint = 0;
      player.outPoint = player.duration;
      player.loop = true;
      await player.seek(0);
      const start = performance.now();
      player.play();
      await new Promise((r) => setTimeout(r, 4800));
      const elapsed = (performance.now() - start) / 1000;
      const expected = elapsed % player.duration;
      const drift = Math.abs(player.currentTime - expected);
      player.dispose();
      return { afterSteps, afterSeek, trimmed, drift: Math.min(drift, player.duration - drift) };
    });
    expect(result.afterSteps).toEqual([0, 120, 160, 120]);
    expect(result.afterSeek).toBe(480);
    expect(result.trimmed.emitted).toEqual([160, 280, 320, 440, 480, 600]);
    expect(result.trimmed.playing).toBe(false);
    expect(result.trimmed.time).toBeCloseTo(0.64, 5);
    expect(result.drift).toBeLessThan(0.05);
  });

  test('frames for auto-levels are spread across the clip and small', async ({ page }) => {
    await open(page, fixture('long_200_frames.gif'));
    const sizes = await page.evaluate(async () => {
      const frames = await window.harness.sampleFramesForLevels(window.harness.media!);
      return frames.map((f) => window.harness.frameStats(f).width);
    });
    expect(sizes).toEqual(new Array(8).fill(160));
  });
});

test.describe('video', () => {
  test('testsrc2_4s.mp4: 4 s, 30 fps, H.264, playable, step moves exactly one frame', async ({ page }) => {
    const summary = await open(page, fixture('testsrc2_4s.mp4'));
    expect(summary).toMatchObject({ kind: 'video', width: 640, height: 360, formatLabel: 'MP4 · H.264', codecLabel: 'H.264', hasAudio: false, canDecodeFrames: true });
    expect(summary.durationSec).toBeCloseTo(4, 1);
    expect(summary.fps).toBeCloseTo(30, 1);

    const result = await page.evaluate(async () => {
      const player = window.harness.player!;
      const times: number[] = [];
      player.onFrame((_frame, t) => times.push(t));

      player.play();
      await new Promise((r) => setTimeout(r, 1000));
      player.pause();
      const played = { frames: times.length, time: player.currentTime };

      await player.seek(1);
      const atSeek = times.at(-1)!;
      await player.step(1);
      const afterStep = times.at(-1)!;
      await player.step(1);
      const afterStep2 = times.at(-1)!;
      await player.step(-2);
      const afterBack = times.at(-1)!;
      player.dispose();
      return { played, atSeek, afterStep, afterStep2, afterBack };
    });
    expect(result.played.frames).toBeGreaterThan(15);
    expect(result.played.time).toBeGreaterThan(0.5);
    expect(result.atSeek).toBeCloseTo(1, 2);
    expect(result.afterStep - result.atSeek).toBeCloseTo(1 / 30, 3);
    expect(result.afterStep2 - result.afterStep).toBeCloseTo(1 / 30, 3);
    expect(result.afterBack).toBeCloseTo(result.atSeek, 3);
  });

  test('variable frame rate: steps visit every frame by its real timestamp', async ({ page }) => {
    const r = await page.evaluate(() => window.harness.vfrStepping(30));
    // The player indexes the clip's own frame times (here 8–33 ms apart; ~54 fps on average).
    expect(r.indexed.length).toBe(r.sourceTimes.length);
    r.indexed.forEach((t, i) => expect(Math.abs(t - r.sourceTimes[i]), `frame ${i}`).toBeLessThan(1e-3));
    // Each step shows the next frame: no repeats, no skips (the 1/fps rule repeated or skipped 14 of 60).
    const frameAt = (t: number) => r.sourceTimes.filter((s) => s <= t + 1e-3).length - 1;
    expect(r.stepped.map(frameAt)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  test('disposing the player settles a seek in flight at once', async ({ page }) => {
    const r = await page.evaluate((u) => window.harness.seekThenDispose(u), fixture('testsrc2_4s.mp4'));
    expect(r.waitedMs).toBeLessThan(1000);
  });

  test('video player trim: loops inside [in, out) and stops at out without loop', async ({ page }) => {
    await open(page, fixture('testsrc2_4s.mp4'));
    const result = await page.evaluate(async () => {
      const player = window.harness.player!;
      const times: number[] = [];
      player.onFrame((_frame, t) => times.push(t));
      player.inPoint = 1;
      player.outPoint = 1.5;
      await player.seek(1);
      player.play();
      await new Promise((r) => setTimeout(r, 1600));
      const looped = { min: Math.min(...times), max: Math.max(...times), playing: player.playing, count: times.length };
      player.loop = false;
      times.length = 0;
      await new Promise((r) => setTimeout(r, 900));
      const stopped = { max: Math.max(...times), playing: player.playing, time: player.currentTime };
      player.dispose();
      return { looped, stopped };
    });
    expect(result.looped.playing).toBe(true);
    expect(result.looped.min).toBeGreaterThanOrEqual(1 - 1 / 30);
    expect(result.looped.max).toBeLessThan(1.5);
    expect(result.looped.count).toBeGreaterThan(30); // more than one pass over the 15-frame range
    expect(result.stopped.playing).toBe(false);
    expect(result.stopped.max).toBeLessThan(1.5);
    expect(result.stopped.time).toBeGreaterThan(1.4);
  });

  test('MediaRecorder WebM (no duration header) with audio: duration probed, audio detected', async ({ page }) => {
    const summary = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 120;
      const ctx = canvas.getContext('2d')!;
      const audio = new AudioContext();
      const oscillator = audio.createOscillator();
      const sink = audio.createMediaStreamDestination();
      oscillator.connect(sink);
      oscillator.start();
      const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...sink.stream.getAudioTracks()]);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      const stopped = new Promise((resolve) => (recorder.onstop = resolve));
      recorder.start();
      const started = performance.now();
      await new Promise<void>((resolve) => {
        const paint = () => {
          const t = performance.now() - started;
          ctx.fillStyle = `hsl(${t / 5}, 80%, 50%)`;
          ctx.fillRect(0, 0, 160, 120);
          if (t < 1200) requestAnimationFrame(paint);
          else resolve();
        };
        paint();
      });
      recorder.stop();
      await stopped;
      await audio.close();
      const media = await window.harness.loadMedia(new Blob(chunks, { type: 'video/webm' }), 'recording.webm');
      const summary = window.harness.summarize(media);
      media.dispose();
      return summary;
    });
    expect(summary).toMatchObject({ kind: 'video', width: 160, height: 120, hasAudio: true });
    expect(summary.formatLabel).toMatch(/^WebM · VP[89]$/);
    expect(summary.durationSec).toBeGreaterThan(0.8);
    expect(summary.durationSec).toBeLessThan(2);
  });

  test('a video codec the browser cannot play fails cleanly with codec-unsupported', async ({ page }) => {
    expect(await loadError(page, '/__generated__/unplayable.mp4')).toEqual({
      code: 'codec-unsupported',
      message: "This browser can’t play this video (MP4). Convert it to H.264 MP4 and try again.",
    });
  });

  test('container rotation is applied by the browser (90° MP4 → portrait)', async ({ page }) => {
    const summary = await open(page, '/__generated__/rotated90.mp4');
    expect(summary).toMatchObject({ kind: 'video', width: 360, height: 640 });
  });

  test('frames for auto-levels come from a separate element and do not move the playhead', async ({ page }) => {
    await open(page, fixture('testsrc2_4s.mp4'));
    const result = await page.evaluate(async () => {
      const media = window.harness.media!;
      if (media.kind !== 'video') throw new Error('not a video');
      media.element.currentTime = 2;
      await new Promise((r) => media.element.addEventListener('seeked', r, { once: true }));
      const frames = await window.harness.sampleFramesForLevels(media);
      const stats = frames.map((f) => window.harness.frameStats(f));
      return { count: frames.length, width: stats[0].width, lumas: stats.map((s) => s.meanLuma), playhead: media.element.currentTime };
    });
    expect(result.count).toBe(8);
    expect(result.width).toBe(256);
    expect(new Set(result.lumas.map((l) => l.toFixed(4))).size).toBeGreaterThan(1);
    expect(result.playhead).toBe(2);
  });
});

test.describe('corpus (local only)', () => {
  test.skip(!hasCorpus, 'local corpus not present');

  test('large and unusual stills', async ({ page }) => {
    expect(await open(page, corpus('images/aerial_4096x2160.jpg'))).toMatchObject({ width: 4096, height: 2160, hasAlpha: false });
    expect(await open(page, corpus('images/exif_orientation6_1200x633.jpg'))).toMatchObject({ width: 633, height: 1200 });
    expect(await open(page, corpus('images/rgba_logo_transparent_800.png'))).toMatchObject({ hasAlpha: true });
    expect(await open(page, corpus('images/cmyk_640.jpg'))).toMatchObject({ width: 640, height: 640, formatLabel: 'JPEG' });
    expect(await open(page, corpus('images/palette_640.png'))).toMatchObject({ width: 640, height: 640, hasAlpha: false });
    expect(await open(page, corpus('images/tall_300x3000.jpg'))).toMatchObject({ width: 300, height: 3000 });
    expect(await open(page, corpus('images/tiny_16x16.png'))).toMatchObject({ width: 16, height: 16 });
    const gray16 = await page.evaluate(async () => {
      const media = await window.harness.loadMedia(await (await fetch('/__corpus__/images/gray16_640x400.png')).blob());
      if (media.kind !== 'image') throw new Error(media.kind);
      return window.harness.frameStats(media.bitmap).meanLuma;
    });
    expect(gray16).toBeGreaterThan(0.05);
    expect(gray16).toBeLessThan(0.95);
  });

  test('GIFs: frame counts, single-frame GIF as still, native-decoder parity', async ({ page }) => {
    expect(await open(page, corpus('gifs/single_frame.gif'))).toMatchObject({ kind: 'image', width: 400, height: 300, formatLabel: 'GIF' });
    expect(await open(page, corpus('gifs/golden_gate_3s_480.gif'))).toMatchObject({ kind: 'animation', frameCount: 36, hasAlpha: false });
    expect(await open(page, corpus('gifs/partial_updates_optimized.gif'))).toMatchObject({ frameCount: 16, hasAlpha: false });
    for (const name of ['golden_gate_3s_480.gif', 'partial_updates_optimized.gif', 'siri_portrait_4s.gif', 'life_5s.gif']) {
      const result = await page.evaluate((u) => window.harness.compareWithNativeDecoder(u), corpus(`gifs/${name}`));
      expect(result.frames, name).toBe(result.nativeFrames);
      expect(result.maxDiff, name).toBe(0);
    }
  });

  test('videos: H.264 720p, VP9 portrait WebM, VFR portrait MP4', async ({ page }) => {
    const golden = await open(page, corpus('videos/golden_gate_6s_720p.mp4'));
    expect(golden).toMatchObject({ kind: 'video', codecLabel: 'H.264', height: 676 });
    expect(golden.durationSec).toBeCloseTo(6, 1);
    expect(golden.fps).toBeCloseTo(30, 1);

    const webm = await open(page, corpus('videos/reframe_portrait_4s.webm'));
    expect(webm).toMatchObject({ kind: 'video', formatLabel: 'WebM · VP9', width: 600, height: 810 });
    expect(webm.durationSec).toBeCloseTo(4, 1);

    const vfr = await open(page, corpus('videos/siri_portrait_8s.mp4'));
    expect(vfr).toMatchObject({ kind: 'video', width: 540, height: 1174 });
    expect(vfr.fps).toBeGreaterThan(40);
    expect(vfr.fps).toBeLessThan(70);

    for (const url of [corpus('videos/golden_gate_6s_720p.mp4'), corpus('videos/reframe_portrait_4s.webm')]) {
      await open(page, url);
      const played = await page.evaluate(async () => {
        const player = window.harness.player!;
        let frames = 0;
        player.onFrame(() => frames++);
        player.play();
        await new Promise((r) => setTimeout(r, 800));
        player.dispose();
        return frames;
      });
      expect(played, url).toBeGreaterThan(10);
    }
  });

  test('HEVC either plays or fails cleanly with codec-unsupported', async ({ page }) => {
    const error = await loadError(page, corpus('videos/reframe_hevc_original.m4v'));
    if (error) {
      expect(error.code).toBe('codec-unsupported');
      expect(error.message).toMatch(/HEVC/);
    } else {
      const summary = await open(page, corpus('videos/reframe_hevc_original.m4v'));
      expect(summary).toMatchObject({ kind: 'video', codecLabel: 'HEVC', width: 1600, height: 2160 });
    }
    test.info().annotations.push({ type: 'hevc', description: error ? `unsupported: ${error.message}` : 'plays' });
  });
});
