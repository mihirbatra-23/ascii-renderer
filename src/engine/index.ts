/**
 * The engine's public surface for the app (docs/ARCHITECTURE.md). Everything outside src/engine
 * should import from here.
 *
 *   createEngine()        WebGL2 renderer, or the CPU fallback when WebGL2 is unavailable
 *                         (`engine.backend` says which)
 *   measureFrameLevels    auto-levels from a still or ~8 frames of a clip (§3)
 *   types + DEFAULT_PARAMS, fonts, geometry helpers, charset presets
 */
export * from './types';
export { createEngine, supportsWebGL2, type EngineOptions } from './gl/create';
export type { EngineBackend, RendererEngine } from './gl/base';
export { measureFrameLevels } from './gl/levels';
export { measureLevels } from './tone';
export { FONTS, loadFont, type BundledFont } from './fonts';
export { analysisSize, computeGeometry, gridSize, rasterSize, DEFAULT_CELL_W, GRID_LIMITS } from './geometry';
export { CHARSET_PRESETS, MAX_GLYPHS, resolveCharset } from './charsets';
