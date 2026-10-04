/**
 * Switch (spec §5 `.swrow`): the whole 32 px row is the <label>, 40 px with a sub-line. On is
 * shown by luminance (`--tx-1` track), never by accent. A disabled row keeps its reason readable.
 *
 *   <SwitchRow label="Invert" kbd="I" checked={invert} onChange={setInvert} />
 *   <SwitchRow label="Transparent background" sub="MP4 has no alpha channel. Use WebM." disabled />
 */
import { useId, type ComponentProps, type ReactNode } from 'react';
import { cx } from './util';

export interface SwitchProps extends Omit<ComponentProps<'input'>, 'type' | 'onChange' | 'checked'> {
  checked: boolean;
  onChange(checked: boolean): void;
}

export function Switch({ checked, onChange, className, ...rest }: SwitchProps) {
  return (
    <input
      type="checkbox"
      role="switch"
      className={cx('sw', className)}
      checked={checked}
      onChange={(e) => onChange(e.currentTarget.checked)}
      {...rest}
    />
  );
}

export interface SwitchRowProps {
  label: ReactNode;
  /** Second line: what it does, or why it is disabled. */
  sub?: ReactNode;
  /** Shortcut chip before the switch. */
  kbd?: string;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  className?: string;
}

/**
 * The switch is named by the label alone and described by the sub-line, so its name is what the
 * row shows in bold (voice control: "click Contour lines") and the sub is read as a description.
 */
export function SwitchRow({ label, sub, kbd, checked, onChange, disabled, className }: SwitchRowProps) {
  const id = useId();
  return (
    <label className={cx('swrow', sub !== undefined && 'tall', disabled && 'off', className)}>
      <span>
        <span id={`${id}-l`}>{label}</span>
        {sub !== undefined && (
          <span id={`${id}-s`} className="sub">
            {sub}
          </span>
        )}
      </span>
      {kbd && <kbd aria-hidden="true">{kbd}</kbd>}
      <Switch checked={checked} onChange={onChange} disabled={disabled} aria-labelledby={`${id}-l`} aria-describedby={sub !== undefined ? `${id}-s` : undefined} />
    </label>
  );
}
