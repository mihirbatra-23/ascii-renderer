import { describe, expect, it } from 'vitest';
import { measureLevels } from '../../src/engine/tone';
import { defaultParams } from '../../src/state/params';
import { invertHint, LIGHT_IMAGE_MEDIAN, medianInk, sampleLumaAlpha } from '../../src/ui/inspector/lightImage';
import { fixturePath, loadRgba } from '../engine/helpers';

const look = defaultParams('a');

async function median(name: string, params = look): Promise<number> {
  const { rgba, width, height } = await loadRgba(fixturePath(name));
  return medianInk(sampleLumaAlpha(rgba, width, height), params, measureLevels(rgba, width, height));
}

describe('Invert hint for mostly light stills', () => {
  it('fires for line art, whose white paper would become the densest glyph', async () => {
    const m = await median('lineart_600x300.png');
    expect(m).toBeGreaterThanOrEqual(LIGHT_IMAGE_MEDIAN);
    expect(invertHint(m, look)).toBe('light');
  });

  it('stays quiet for photographs, renders and gradients', async () => {
    for (const name of ['torus_450.png', 'terrain_640x360.png', 'waves_600x400.png', 'gradient_512x64.png', 'exif6_480x270.jpg']) {
      expect(invertHint(await median(name), look), name).toBeNull();
    }
  });

  it('counts transparent pixels as paper, so a white logo on transparency does not fire', async () => {
    expect(invertHint(await median('logo_rgba_256.png'), look)).toBeNull();
  });

  it('goes away once Invert is on, and names a dark image on light paper', async () => {
    const m = await median('lineart_600x300.png');
    expect(invertHint(m, { ...look, invert: true })).toBeNull();
    expect(invertHint(0.99, { invert: false, ink: '#111111', paper: '#f4f1ea' })).toBe('dark');
  });
});
