/**
 * Switch (spec §5 `.swrow`): the whole 32 px row is the <label>, 40 px with a sub-line. On is
 * shown by luminance (`--tx-1` track), never by accent. A disabled row keeps its reason readable.
 *
 *   <SwitchRow label="Invert" tooltip={{ body: 'Swaps light and dark', shortcut: 'I' }} tooltipOn="switch" … />
 *   <SwitchRow label="Contour lines" tooltip="Adds strokes along strong edges." … />
 *   <SwitchRow label="Transparent background" sub="MP4 has no alpha channel. Use WebM." disabled />
 */
import { useId, type ComponentProps, type ReactNode } from 'react';
import { rowTip, TipLabel, useTip, type RowTooltip } from './Tooltip';
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
  /** Shortcut chip before the switch. Prefer `tooltip` with a shortcut: the dock shows no chips. */
  kbd?: string;
  /**
   * A tip. On the label (default) it is a note with the dotted indicator; on the switch it is a
   * one-line label tip with no indicator (Invert: "Swaps light and dark" + I).
   */
  tooltip?: RowTooltip;
  tooltipOn?: 'label' | 'switch';
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  className?: string;
}

/**
 * The switch is named by the label alone and described by the sub-line (or the tip), so its name
 * is what the row shows in bold (voice control: "click Contour lines") and the rest is read as a
 * description.
 */
export function SwitchRow({ label, sub, kbd, tooltip, tooltipOn = 'label', checked, onChange, disabled, className }: SwitchRowProps) {
  const id = useId();
  const t = rowTip(tooltip);
  const onSwitch = tooltipOn === 'switch';
  const tip = useTip(
    t && (onSwitch && typeof t.body === 'string' ? { label: t.body, shortcut: t.shortcut } : { body: t.body, shortcut: t.shortcut }),
    { tap: !onSwitch, describe: true },
  );
  const describedBy = [sub !== undefined ? `${id}-s` : undefined, tip.focus['aria-describedby']].filter(Boolean).join(' ') || undefined;
  return (
    <label className={cx('swrow', sub !== undefined && 'tall', disabled && 'off', className)}>
      <span>
        <span id={`${id}-l`}>{t && !onSwitch ? <TipLabel tip={tip}>{label}</TipLabel> : label}</span>
        {sub !== undefined && (
          <span id={`${id}-s`} className="sub">
            {sub}
          </span>
        )}
      </span>
      {kbd && <kbd aria-hidden="true">{kbd}</kbd>}
      <Switch
        ref={onSwitch ? tip.anchorRef : undefined}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        aria-labelledby={`${id}-l`}
        aria-describedby={describedBy}
        onFocus={tip.focus.onFocus}
        onBlur={tip.focus.onBlur}
        {...(onSwitch ? tip.hover : undefined)}
      />
      {tip.node}
    </label>
  );
}
