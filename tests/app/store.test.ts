import { describe, expect, it } from 'vitest';
import { defaultParams, sanitizeParams } from '../../src/state/params';
import { describeParamChange, INITIAL_EXPORT_UI, loadExportUi, loadParams, loadUserPresets } from '../../src/state/store';

/** Everything restored from localStorage is validated, so the UI never promises what the file won't be. */
describe('restoring persisted state', () => {
  it('keeps valid export settings and drops out-of-range or foreign ones', () => {
    expect(loadExportUi({ scale: 4, motionScale: 2, margin: 12, svgText: 'text', transparent: true, pixelSnap: false, includeAudio: false })).toEqual({
      ...INITIAL_EXPORT_UI,
      scale: 4,
      motionScale: 2,
      margin: 12,
      svgText: 'text',
      transparent: true,
      pixelSnap: false,
      includeAudio: false,
    });
    // A real case: scale 3 and a negative margin made the panel promise 3798 px for a 3840 px file.
    expect(loadExportUi({ scale: 3, margin: -7, svgText: 'bogus', transparent: 'yes', motionScale: 'custom' })).toEqual(INITIAL_EXPORT_UI);
    expect(loadExportUi({ margin: 2.5 }).margin).toBe(0);
    expect(loadExportUi({ margin: 10_000 }).margin).toBe(0);
    expect(loadExportUi('garbage')).toEqual(INITIAL_EXPORT_UI);
    expect(loadExportUi(null)).toEqual(INITIAL_EXPORT_UI);
  });

  it('defaults motion formats to 1×, apart from the PNG scale', () => {
    expect(INITIAL_EXPORT_UI.motionScale).toBe(1);
    expect(loadExportUi({ scale: 2 }).motionScale).toBe(1);
  });

  it('restores user presets named, deduplicated and sanitised', () => {
    const presets = loadUserPresets(
      [
        { name: '  Night  ', params: { contrast: 1.4 } },
        { name: '', params: {} },
        { name: 42, params: {} },
        null,
        { name: 'Night', params: { contrast: 1.6, columns: -3, edges: true } },
        { name: 'x'.repeat(200), params: 'nope' },
      ],
    );
    expect(presets.map((p) => p.name)).toEqual(['Night', 'x'.repeat(60)]);
    expect(presets[0].params).toEqual({ ...defaultParams(), contrast: 1.6, columns: 40, edges: true });
    expect(presets[1].params).toEqual(defaultParams());
    expect(loadUserPresets({ not: 'an array' })).toEqual([]);
  });

  it('moves a Carbon user’s untouched render colors to the defaults and keeps customized ones', () => {
    const defaults = defaultParams();
    const carbon = { ink: '#e4e7e8', shadowInk: '#6d7274', paper: '#0a0b0b' };
    expect(loadParams({ ...defaults, ...carbon, contrast: 1.4 })).toEqual({ ...defaults, contrast: 1.4 });
    expect(loadParams({ ...defaults, ...carbon, ink: '#ff0000' })).toEqual({ ...defaults, ...carbon, ink: '#ff0000' });
  });

  it('validates the edge layer like every other parameter', () => {
    const base = defaultParams();
    expect(sanitizeParams({ edges: true, edgeThreshold: 0.333 }, base)).toMatchObject({ edges: true, edgeThreshold: 0.33 });
    expect(sanitizeParams({ edges: 1, edgeThreshold: Number.NaN }, base)).toMatchObject({ edges: base.edges, edgeThreshold: base.edgeThreshold });
    expect(sanitizeParams({ edgeThreshold: -2 }, base).edgeThreshold).toBe(0);
  });
});

describe('undo announcements', () => {
  const base = defaultParams();
  it('names what changed', () => {
    expect(describeParamChange(base, { ...base, contrast: 1.3 })).toBe('Contrast');
    expect(describeParamChange(base, { ...base, contrast: 1.3, gamma: 0.8 })).toBe('Contrast and Gamma');
    expect(describeParamChange(base, { ...base, mode: 'ramp', contrast: 1.3, gamma: 0.8, dither: 0 })).toBe('Mode, Contrast and 2 more');
  });
});
