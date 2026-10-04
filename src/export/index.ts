/**
 * Exporters: projections of the engine's single grid + geometry (see ./types.ts).
 *
 * Pure (DOM-free, unit-tested in Node): snapshotToText, snapshotToHtml, snapshotToSvg, timing and
 * size helpers.
 * Browser: exportPng / exportGif / exportVideo (engine rasters read back asynchronously; encoding in
 * workers / WebCodecs), startRecording (live cameras), exportTxt / exportHtml / exportSvg (Blob
 * wrappers), estimateExport, saveBlob, copy* helpers.
 */
export type * from './types';

export { snapshotToText, snapshotRows, halftoneChar } from './txt';
export { snapshotToHtml, escapeHtml, type HtmlExportOptions } from './html';
export { snapshotToSvg, type SvgExport, type SvgExportOptions } from './svg';
export { loadOutlines, type GlyphOutlines } from './outlines';
export { fetchEmbeddedFont, type EmbeddedFont } from './font-embed';
export { bundledFont } from './fonts';

export { exportTxt, exportHtml, exportSvg, type TxtExportOptions, type HtmlExportFileOptions, type SvgExportFileOptions } from './still';
export { exportPng, type PngExportOptions } from './png';
export { exportGif, type GifExportOptions } from './gif';
export { exportVideo, type FrameSequence, type VideoExportInput, type VideoExportOptions } from './video';
export { exportAudioPlan, type AudioPlan } from './audio';
export { startRecording, type LiveRecording, type RecordingOptions } from './recorder';
export { estimateExport, LARGE_GIF_BYTES, type EstimateMedia, type GifDeltaSampler } from './estimate';

export { animationFrames, animationSamples, stillFrames, videoFrames, videoSamples, type ExportFrame, type FrameInput } from './frames';
export { animationSpans, gifFps, gifRepeatCount, spreadTimes, videoFrameTimes, type TimeRange } from './timing';
export { gridPixelSize, maxScale, evenSize, MAX_CANVAS_AREA, type PixelSize } from './geometry';
export { planOutput, targetSize, type OutputPlan, type OutputRequest } from './output';
export { hasWebCodecs } from './video-codecs';

export { saveBlob } from './download';
export { copyText, copyPng, copySvg } from './clipboard';
export { exportFileName } from './filename';
export { ExportError, isAbortError, type ExportErrorCode } from './errors';
export type { ProgressCallback } from './progress';
