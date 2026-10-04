import { describe, expect, it } from 'vitest';
import { exportFileName } from '../../src/export/filename';
import { evenSize, gridPixelSize, maxScale } from '../../src/export/geometry';
import { animationSpans, gifFps, gifRepeatCount, videoFrameTimes } from '../../src/export/timing';
import { GEOMETRY } from './helpers';

describe('timing', () => {
  it('clips animation frames to the trim range', () => {
    const durations = [100, 100, 100, 100];
    expect(animationSpans(durations)).toEqual([
      [0, 100],
      [1, 100],
      [2, 100],
      [3, 100],
    ]);
    expect(animationSpans(durations, { startSec: 0.15, endSec: 0.25 })).toEqual([
      [1, 50],
      [2, 50],
    ]);
    expect(animationSpans(durations, { startSec: 1, endSec: 2 })).toEqual([]);
  });

  it('samples video frame times at a constant rate without overshooting the end', () => {
    expect(videoFrameTimes(1, {}, 10)).toHaveLength(10);
    expect(videoFrameTimes(4, { startSec: 1, endSec: 2 }, 25)).toHaveLength(25);
    expect(videoFrameTimes(4, { startSec: 1, endSec: 2 }, 25)[0]).toBe(1);
    expect(videoFrameTimes(2, {}, 30)).toHaveLength(60);
  });

  it('caps GIF frame rates', () => {
    expect(gifFps(30)).toBe(25);
    expect(gifFps(12)).toBe(12);
    expect(gifFps(30, 100)).toBe(50);
    expect(gifFps(30, 10)).toBe(10);
  });

  it('maps total plays (LoadedAnimation.loopCount) to the NETSCAPE repeat count', () => {
    expect(gifRepeatCount(0)).toBe(0); // forever
    expect(gifRepeatCount(1)).toBe(-1); // once: no NETSCAPE extension
    expect(gifRepeatCount(2)).toBe(1);
    expect(gifRepeatCount(3)).toBe(2);
    expect(gifRepeatCount(70_000)).toBe(0xffff);
    expect(gifRepeatCount(Number.NaN)).toBe(0);
  });
});

describe('geometry', () => {
  it('sizes the grid exactly from the cell geometry', () => {
    expect(gridPixelSize({ cols: 160, rows: 45 }, GEOMETRY, 0)).toEqual({ width: 1280, height: 720 });
    expect(gridPixelSize({ cols: 160, rows: 45 }, GEOMETRY, 8)).toEqual({ width: 1296, height: 736 });
  });

  it('finds the largest scale that fits the device', () => {
    expect(maxScale({ cols: 160, rows: 45 }, GEOMETRY, 0, 4096)).toBe(3);
    expect(maxScale({ cols: 400, rows: 300 }, GEOMETRY, 0, 4096)).toBe(0);
  });

  it('pads odd sizes to even', () => {
    expect(evenSize({ width: 641, height: 360 })).toEqual({ width: 642, height: 360 });
  });
});

describe('exportFileName', () => {
  it('builds <source>-ascii-<cols>x<rows>.<ext>', () => {
    expect(exportFileName('Golden Gate.mp4', { cols: 160, rows: 45 }, 'webm')).toBe('Golden-Gate-ascii-160x45.webm');
    expect(exportFileName('a/b:c?.png', { cols: 80, rows: 40 }, '.svg')).toBe('a-b-c-ascii-80x40.svg');
    expect(exportFileName('', { cols: 80, rows: 40 }, 'txt')).toBe('image-ascii-80x40.txt');
    expect(exportFileName('pasted image', { cols: 80, rows: 40 }, 'png')).toBe('pasted-image-ascii-80x40.png');
  });
});
