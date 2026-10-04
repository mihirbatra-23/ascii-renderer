/**
 * Text field (spec §5 `.field`): 32 px, `--g2`. Mono value (file names, URLs), sans placeholder,
 * optional leading icon, fixed prefix ('#') / suffix ('.png', '100%') and an inline small action (Load).
 *
 *   <TextField icon="link" placeholder="Paste an image or video URL" action={<Button size="sm">Load</Button>} />
 *   <TextField value={name} onChange={…} suffix=".png" aria-label="File name" />
 */
import type { ComponentProps, ReactNode } from 'react';
import { Icon, type IconName } from '../icons';
import { cx } from './util';

export interface TextFieldProps extends Omit<ComponentProps<'input'>, 'prefix'> {
  icon?: IconName;
  /** Fixed text before the value, e.g. '#'. */
  prefix?: string;
  suffix?: string;
  action?: ReactNode;
  /** Class on the outer `.field` box (the input itself takes the other props). */
  fieldClassName?: string;
}

export function TextField({ icon, prefix, suffix, action, fieldClassName, type = 'text', ...input }: TextFieldProps) {
  return (
    <div className={cx('field', fieldClassName)}>
      {icon && <Icon name={icon} />}
      {prefix && <span className="suf">{prefix}</span>}
      <input type={type} spellCheck={false} autoComplete="off" {...input} />
      {suffix && <span className="suf">{suffix}</span>}
      {action}
    </div>
  );
}
