import { describe, expect, it } from 'vitest';
import { decodeSettings, encodeSettings } from '../../src/app/permalink';
import { defaultParams } from '../../src/state/params';

/** Settings links: only non-default params travel, everything coming back is validated. */
describe('settings links', () => {
  const defaults = defaultParams();

  it('round-trips a look, including unicode glyph sets and the edge layer', () => {
    const params = { ...defaults, mode: 'ramp' as const, columns: 212, contrast: 1.35, charsetPreset: 'custom' as const, customCharset: ' ░▒▓█·•●', edges: true, edgeThreshold: 0.35 };
    const payload = encodeSettings(params);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeSettings(payload)).toEqual(params);
  });

  it('carries only what differs from the defaults', () => {
    const payload = encodeSettings({ ...defaults, gamma: 0.8 });
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    expect(json).toEqual({ v: 1, p: { gamma: 0.8 } });
    expect(JSON.parse(Buffer.from(encodeSettings(defaults), 'base64url').toString('utf8'))).toEqual({ v: 1, p: {} });
  });

  it('fills what the link leaves out from the defaults (old Carbon links included)', () => {
    expect(decodeSettings(encodeSettings({ ...defaults, columns: 90 }))).toEqual({ ...defaults, columns: 90 });
    // A link made under Carbon with its own ink carries that ink as an ordinary value.
    const carbon = { ...defaults, ink: '#e4e7e8', paper: '#0a0b0b' };
    expect(decodeSettings(encodeSettings(carbon))).toEqual(carbon);
  });

  it('clamps and filters hostile values instead of passing them to the engine', () => {
    const payload = Buffer.from(
      JSON.stringify({ v: 1, p: { columns: 1e9, gamma: -4, mode: 'evil', ink: 'red', edges: 'yes', edgeThreshold: 7, invert: true, customCharset: 'x'.repeat(5000), __proto__: { polluted: 1 } } }),
    ).toString('base64url');
    const decoded = decodeSettings(payload)!;
    expect(decoded.columns).toBe(400);
    expect(decoded.gamma).toBe(0.4);
    expect(decoded.mode).toBe(defaults.mode);
    expect(decoded.ink).toBe(defaults.ink);
    expect(decoded.edges).toBe(defaults.edges);
    expect(decoded.edgeThreshold).toBe(1);
    expect(decoded.invert).toBe(true);
    expect(decoded.customCharset.length).toBe(1024);
    expect(Object.keys(decoded).sort()).toEqual(Object.keys(defaults).sort());
  });

  it('rejects malformed, truncated and future-version payloads', () => {
    expect(decodeSettings('not base64 !!')).toBeNull();
    expect(decodeSettings(encodeSettings({ ...defaults, gamma: 0.8 }).slice(0, 5))).toBeNull();
    expect(decodeSettings(Buffer.from(JSON.stringify({ v: 2, p: { gamma: 0.8 } })).toString('base64url'))).toBeNull();
    expect(decodeSettings(Buffer.from('[1,2]').toString('base64url'))).toBeNull();
  });
});
