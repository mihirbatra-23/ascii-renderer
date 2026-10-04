/**
 * Segmented control (spec §5, `.seg`): 32 px, options split by hairlines, the selected one gets
 * `--g3` and a 2 px accent underline.
 *
 * `kind="radio"` (default) is a radiogroup with arrow keys and one tab stop: modes, color,
 * scale, speed, fps. `kind="toggle"` renders aria-pressed buttons (the stage view switch).
 * `variant="two"` is the 44 px label + sub-value form (export scale); `"mono"` sets values in mono.
 * `icons` sets how option icons show, for every segment together: 'always' (default) icon + text,
 * 'never' text only (the icon is ignored), 'only' icon only with the text as the accessible name.
 */
import type { ReactNode } from 'react';
import { Icon, type IconName } from '../icons';
import { onRovingKeyDown, rovingTabIndex } from './radio';
import { cx } from './util';

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: ReactNode;
  /** Second line in the 'two' variant (e.g. '2560 × 1440'). */
  sub?: ReactNode;
  icon?: IconName;
  disabled?: boolean;
  /** Accessible name when the label alone is ambiguous. */
  ariaLabel?: string;
}

export interface SegmentedProps<T extends string | number> {
  /** T is inferred from the options (as literals), so value / onChange get the exact union. */
  options: readonly SegmentedOption<T>[];
  value: NoInfer<T>;
  onChange(value: NoInfer<T>): void;
  /** Accessible group name. */
  label?: string;
  labelledBy?: string;
  kind?: 'radio' | 'toggle';
  variant?: 'mono' | 'two';
  /** Stretch to the container width with equal columns. */
  full?: boolean;
  icons?: 'always' | 'never' | 'only';
  className?: string;
}

export function Segmented<const T extends string | number>({
  options,
  value,
  onChange,
  label,
  labelledBy,
  kind = 'radio',
  variant,
  full,
  icons = 'always',
  className,
}: SegmentedProps<T>) {
  const radio = kind === 'radio';
  const anyChecked = options.some((o) => o.value === value);
  return (
    <div
      className={cx('seg', variant, full && 'full', icons === 'only' && 'icons', className)}
      role={radio ? 'radiogroup' : 'group'}
      aria-label={label}
      aria-labelledby={labelledBy}
      onKeyDown={radio ? (e) => onRovingKeyDown(e) : undefined}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        const icon = icons !== 'never' && o.icon;
        const iconOnly = icons === 'only' && Boolean(o.icon);
        return (
          <button
            key={String(o.value)}
            type="button"
            role={radio ? 'radio' : undefined}
            aria-checked={radio ? on : undefined}
            aria-pressed={radio ? undefined : on}
            aria-label={o.ariaLabel ?? (iconOnly && typeof o.label === 'string' ? o.label : undefined)}
            tabIndex={radio ? rovingTabIndex(on, i, anyChecked) : undefined}
            disabled={o.disabled}
            onClick={() => !on && onChange(o.value)}
          >
            {icon && <Icon name={icon} />}
            {iconOnly ? null : variant === 'two' ? (
              <>
                <b>{o.label}</b>
                {o.sub !== undefined && <small>{o.sub}</small>}
              </>
            ) : (
              o.label
            )}
          </button>
        );
      })}
    </div>
  );
}
