import { describe, expect, it } from 'vitest';
import { svgRasterSize } from '../../src/media/svg-size';

const svg = (attrs: string) => `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect/></svg>`;

describe('svgRasterSize', () => {
  it.each([
    ['absolute px size', 'width="1600" height="900"', 1600, 900],
    ['unitless size', "width='1200' height='1500'", 1200, 1500],
    ['size wins over viewBox', 'width="1280" height="1024" viewBox="0 0 10 10"', 1280, 1024],
    ['viewBox only → 2048 on the long side', 'viewBox="0 0 200 100"', 2048, 1024],
    ['portrait viewBox only', 'viewBox="0,0,50,200"', 512, 2048],
    ['width + viewBox → height from aspect', 'width="2000" viewBox="0 0 4 3"', 2000, 1500],
    ['height + viewBox → width from aspect', 'height="1500" viewBox="0 0 4 3"', 2000, 1500],
    ['percentages are not intrinsic', 'width="100%" height="100%" viewBox="0 0 300 300"', 2048, 2048],
    ['physical units', 'width="20in" height="10in"', 1920, 960],
    ['small icons are rasterised at ≥ 1024 px', 'width="24" height="24" viewBox="0 0 24 24"', 1024, 1024],
    ['huge sizes are capped at 4096 px', 'width="20000" height="10000"', 4096, 2048],
    ['nothing at all → CSS default 300×150 (scaled up)', '', 1024, 512],
    ['stroke-width is not width', 'stroke-width="3" viewBox="0 0 100 50"', 2048, 1024],
  ])('%s', (_label, attrs, width, height) => {
    expect(svgRasterSize(svg(attrs))).toEqual({ width, height });
  });

  it('ignores invalid lengths and viewBoxes', () => {
    expect(svgRasterSize(svg('width="auto" height="-5" viewBox="0 0 0 10"'))).toEqual({ width: 1024, height: 512 });
  });
});
