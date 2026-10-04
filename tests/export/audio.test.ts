import { describe, expect, it } from 'vitest';
import { planAudio } from '../../src/export/audio';

const track = (codec: string | null) => ({ codec, numberOfChannels: 2, sampleRate: 48000 }) as Parameters<typeof planAudio>[0];
const everything = async () => true;
const nothing = async () => false;

describe('planAudio', () => {
  it('MP4 copies AAC / MP3 and converts anything else to AAC', async () => {
    expect((await planAudio(track('aac'), 'mp4', everything)).plan).toEqual({ action: 'copy', from: 'AAC', to: 'AAC', note: undefined });
    expect((await planAudio(track('mp3'), 'mp4', everything)).options).toEqual({});
    const opus = await planAudio(track('opus'), 'mp4', everything);
    expect(opus.plan).toMatchObject({ action: 'transcode', from: 'Opus', to: 'AAC' });
    expect(opus.plan.note).toMatch(/converted from Opus to AAC/);
    expect(opus.options).toEqual({ codec: 'aac', forceTranscode: true });
  });

  it('MP4 keeps a codec it cannot convert, and says why that may matter', async () => {
    const r = await planAudio(track('opus'), 'mp4', nothing);
    expect(r.plan).toMatchObject({ action: 'copy', to: 'Opus' });
    expect(r.plan.note).toMatch(/Some players can’t play it in MP4/);
  });

  it('WebM copies Opus / Vorbis, converts the rest to Opus, or drops audio it cannot encode', async () => {
    expect((await planAudio(track('vorbis'), 'webm', everything)).plan.action).toBe('copy');
    expect((await planAudio(track('aac'), 'webm', everything)).plan).toMatchObject({ action: 'transcode', from: 'AAC', to: 'Opus' });
    const none = await planAudio(track('aac'), 'webm', nothing);
    expect(none.plan.action).toBe('none');
    expect(none.options).toEqual({ discard: true });
  });
});
