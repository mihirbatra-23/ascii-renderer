/**
 * Mode tiles (spec §5, `.mode`): 56 px tiles (52 px in the phone strip) with a specimen above a
 * 12 px label; the selected tile gets `--g3`, a `--line-3` border and a 2 px accent bar.
 *
 *   <ModeTiles value={mode} onChange={setMode} />                       the dock's Mode section
 *   <ModeTiles value={mode} onChange={setMode} className="mstrip" />    the phone strip
 *   <Tile checked specimen="/|\_" label="Shape" />                      a single radio tile
 */
import type { ComponentProps, ReactNode } from 'react';
import type { RenderMode } from '../../engine/types';
import { RENDER_MODES } from '../../state/params';
import { ModeSpecimen } from '../icons';
import { onRovingKeyDown, rovingTabIndex } from './radio';
import { cx } from './util';

export const MODE_LABELS: Record<RenderMode, string> = {
  shape: 'Shape',
  ramp: 'Ramp',
  braille: 'Braille',
  halftone: 'Halftone',
  blocks: 'Blocks',
};

export interface TileProps extends Omit<ComponentProps<'button'>, 'children'> {
  checked: boolean;
  specimen: ReactNode;
  label: ReactNode;
}

export function Tile({ checked, specimen, label, className, type = 'button', ...rest }: TileProps) {
  return (
    <button type={type} role="radio" aria-checked={checked} className={cx('mode', className)} {...rest}>
      <span className="spec" aria-hidden="true">
        {specimen}
      </span>
      <span>{label}</span>
    </button>
  );
}

export interface ModeTilesProps {
  value: RenderMode;
  onChange(mode: RenderMode): void;
  /** Defaults to the dock grid (`modes`); pass `mstrip` for the phone strip. */
  className?: string;
  label?: string;
}

export function ModeTiles({ value, onChange, className = 'modes', label = 'Render mode' }: ModeTilesProps) {
  return (
    <div className={className} role="radiogroup" aria-label={label} onKeyDown={(e) => onRovingKeyDown(e)}>
      {RENDER_MODES.map((mode, i) => (
        <Tile
          key={mode}
          checked={mode === value}
          tabIndex={rovingTabIndex(mode === value, i, true)}
          specimen={<ModeSpecimen mode={mode} />}
          label={MODE_LABELS[mode]}
          onClick={() => mode !== value && onChange(mode)}
        />
      ))}
    </div>
  );
}
