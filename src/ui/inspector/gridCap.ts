import { GRID_LIMITS } from '../../engine/geometry';
import type { CellGeometry, GridSize } from '../../engine/types';

/**
 * The limit that stopped the grid at `grid.cols` (engine geometry.gridSize): one more column would
 * need more rows than a grid holds (tall sources), or else more cells. Rows follow ALGORITHM §1.
 */
export function capReason(grid: GridSize, srcW: number, srcH: number, cell: Pick<CellGeometry, 'cellW' | 'cellH'>): 'rows' | 'cells' {
  const rowsForNext = Math.round((grid.cols + 1) * (srcH / srcW) * (cell.cellW / cell.cellH));
  return rowsForNext > GRID_LIMITS.maxRows ? 'rows' : 'cells';
}
