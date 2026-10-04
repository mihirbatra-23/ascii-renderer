import { afterEach, describe, expect, it, vi } from 'vitest';
import { openCamera } from '../../src/media/camera';
import { MediaError } from '../../src/media/types';

async function errorOf(promise: Promise<unknown>): Promise<MediaError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MediaError) return error;
    throw error;
  }
  throw new Error('expected openCamera to fail');
}

function deviceThatThrows(name: string) {
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => Promise.reject(new DOMException('denied', name)) } });
}

describe('openCamera errors are MediaErrors written for people', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('an insecure page is camera-blocked and says to use https', async () => {
    vi.stubGlobal('isSecureContext', false);
    const error = await errorOf(openCamera());
    expect(error.code).toBe('camera-blocked');
    expect(error.message).toMatch(/https/);
  });

  it('a browser without getUserMedia is camera-unavailable', async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', {});
    expect((await errorOf(openCamera())).code).toBe('camera-unavailable');
  });

  it.each([
    ['NotAllowedError', 'camera-blocked', /Allow the camera for this site/],
    ['SecurityError', 'camera-blocked', /Allow the camera/],
    ['NotFoundError', 'camera-unavailable', /No camera found/],
    ['OverconstrainedError', 'camera-unavailable', /requested settings/],
    ['NotReadableError', 'camera-unavailable', /Close any other app using it/],
    ['AbortError', 'camera-unavailable', /couldn’t start/],
  ])('%s → %s', async (name, code, message) => {
    deviceThatThrows(name);
    const error = await errorOf(openCamera());
    expect(error.code).toBe(code);
    expect(error.message).toMatch(message);
  });

  it('an aborted request rejects before asking for the camera', async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const controller = new AbortController();
    controller.abort();
    await expect(openCamera(undefined, { signal: controller.signal })).rejects.toThrow();
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
