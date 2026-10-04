/**
 * What two consecutive frames cost in a GIF, for the size estimate (gif-estimate.ts). Encoded with
 * the GIF exporter's own pieces and scheme (gif.worker.ts): one global palette (fixed, or quantized
 * from the frames), a reserved transparent index, and only the changed rectangle of the second frame.
 */
import { quantize } from 'gifenc';
import { FrameDiffer } from './gif-delta';
import { PaletteMapper, samplePixels, snapToPalette, withTransparentSlot, type Palette } from './gif-palette';
import { GifWriter } from './gif-writer';
import type { OwnedPixels } from './resample';

/** Pixels sampled per frame to quantize an adaptive palette (as the GIF worker samples). */
const SAMPLE_PIXELS = 1 << 16;

/**
 * Bytes of `a` as a GIF's first frame and of `b` as the delta frame after it, encoded as gif.worker.ts
 * encodes a clip: the fixed palette (or one quantized from both frames, as the export quantizes from
 * frames across the clip), a reserved transparent index, and only the changed rectangle for `b`.
 */
export function gifPairBytes(a: OwnedPixels, b: OwnedPixels, fixed: Palette | null, paper: [number, number, number]): { firstBytes: number; deltaBytes: number } {
  if (b.width !== a.width || b.height !== a.height) throw new Error('The two frames differ in size.');
  let palette = fixed;
  if (!palette) {
    const sa = samplePixels(a.data, SAMPLE_PIXELS);
    const sb = samplePixels(b.data, SAMPLE_PIXELS);
    const both = new Uint8Array(sa.length + sb.length);
    both.set(sa);
    both.set(sb, sa.length);
    palette = snapToPalette(quantize(both, 255), paper);
  }
  const { table, transparentIndex } = withTransparentSlot(palette, paper);
  const mapper = new PaletteMapper(palette, paper);
  const encodedBytes = (frames: readonly OwnedPixels[]) => {
    const writer = new GifWriter(a.width, a.height, table, 0);
    const differ = new FrameDiffer(a.width, a.height, transparentIndex);
    for (const frame of frames) {
      const delta = differ.next(mapper.map(frame.data));
      writer.writeFrame(delta.indices, delta.rect, { delayCs: 4, disposal: 1, transparentIndex: delta.transparent ? transparentIndex : undefined });
    }
    return writer.finish().byteLength;
  };
  const firstBytes = encodedBytes([a]);
  return { firstBytes, deltaBytes: encodedBytes([a, b]) - firstBytes };
}
