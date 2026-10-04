/**
 * Grid: the Columns hero slider. The head shows the rows, derived with the same geometry the
 * engine uses (rows = round(cols · H/W · cellW/cellH), ALGORITHM §1); the cell is in Advanced.
 * [ and ] step the columns (Shortcuts sheet, and the Columns tooltip).
 */
import { GRID_LIMITS, gridSize } from '../../engine/geometry';
import { DEFAULT_PARAMS } from '../../engine/types';
import { NUMERIC_SPECS } from '../../state/params';
import { useStore } from '../../state/store';
import { HeroSlider, Section } from '../kit';
import { commitLive, setLive } from './controls';
import { TIPS } from './copy';
import { capReason } from './gridCap';
import { useCellGeometry } from './glyphInfo';

const MAJORS = [40, 100, 200, 300, 400] as const;
const { min, max, step, format } = NUMERIC_SPECS.columns;

export function GridSection() {
  const columns = useStore((s) => s.params.columns);
  const srcW = useStore((s) => s.media.info?.width ?? 0);
  const srcH = useStore((s) => s.media.info?.height ?? 0);
  const cell = useCellGeometry();
  const grid = srcW > 0 && srcH > 0 ? gridSize(srcW, srcH, columns, cell) : null;
  return (
    <Section
      title="Grid"
      tab="adjust"
      aux={
        <>
          {grid ? grid.rows : '–'} <em>rows</em>
        </>
      }
    >
      <HeroSlider
        label="Columns"
        tooltip={{ body: TIPS.columns, shortcut: ['[', ']'] }}
        unit="col"
        value={columns}
        min={min}
        max={max}
        step={step}
        format={format}
        defaultValue={DEFAULT_PARAMS.columns}
        majors={MAJORS}
        minorStep={10}
        onChange={(v) => setLive('columns', v)}
        onCommit={commitLive}
      />
      {grid && grid.cols < columns && (
        <p className="hint">
          Limited to <b>{grid.cols}</b> columns.{' '}
          {capReason(grid, srcW, srcH, cell) === 'rows'
            ? `A grid has at most ${GRID_LIMITS.maxRows} rows.`
            : `A grid has at most ${GRID_LIMITS.maxCells.toLocaleString('en-US')} cells.`}
        </p>
      )}
    </Section>
  );
}
