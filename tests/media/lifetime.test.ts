import { describe, expect, it, vi } from 'vitest';
import { CLOSED_MESSAGE, Lifetime } from '../../src/media/lifetime';

describe('Lifetime (MediaBase.retain / dispose)', () => {
  it('releases at once when nothing holds it', () => {
    const release = vi.fn();
    const lifetime = new Lifetime(release);
    lifetime.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    expect(lifetime.alive).toBe(false);
  });

  it('defers disposal until every retain is released', () => {
    const release = vi.fn();
    const lifetime = new Lifetime(release);
    const exportA = lifetime.retain();
    const exportB = lifetime.retain();
    lifetime.dispose();
    expect(release).not.toHaveBeenCalled();
    expect(lifetime.alive).toBe(true);
    exportA();
    expect(release).not.toHaveBeenCalled();
    exportB();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a release function only counts once, and dispose is idempotent', () => {
    const release = vi.fn();
    const lifetime = new Lifetime(release);
    const held = lifetime.retain();
    const other = lifetime.retain();
    held();
    held();
    lifetime.dispose();
    lifetime.dispose();
    expect(release).not.toHaveBeenCalled();
    other();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('retains taken and released before dispose do not release anything', () => {
    const release = vi.fn();
    const lifetime = new Lifetime(release);
    lifetime.retain()();
    expect(release).not.toHaveBeenCalled();
    expect(lifetime.alive).toBe(true);
  });

  it('refuses a retain once released, with a message for users', () => {
    const lifetime = new Lifetime(() => undefined);
    lifetime.dispose();
    expect(() => lifetime.retain()).toThrow(CLOSED_MESSAGE);
  });
});
