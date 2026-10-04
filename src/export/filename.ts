import type { GridSize } from '../engine/types';

/** '<source-name>-ascii-<cols>x<rows>.<ext>', with the source's extension and unsafe characters removed. */
export function exportFileName(sourceName: string, grid: GridSize, ext: string): string {
  const base = sourceName
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return `${base || 'image'}-ascii-${grid.cols}x${grid.rows}.${ext.replace(/^\./, '')}`;
}
