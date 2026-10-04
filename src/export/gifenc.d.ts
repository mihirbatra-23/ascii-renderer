// Types for gifenc 1.0.3 (the package ships none); only the quantizer is used (gif-writer.ts writes the file).
declare module 'gifenc' {
  export type GifPalette = number[][];
  export type GifColorFormat = 'rgb565' | 'rgb444' | 'rgba4444';

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: GifColorFormat; oneBitAlpha?: boolean | number },
  ): GifPalette;
}
