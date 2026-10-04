/**
 * Buttons (spec §5): 32 px, 4 px radius, 13 px / 500. Icon first, optional kbd hint last.
 *
 *   <Button variant="primary" icon="export" kbd="⌘E">Export</Button>
 *   <IconButton icon="undo" label="Undo" shortcut="⌘Z" />          ghost, 32 × 32, tooltip
 *   <LinkButton href="…" icon="branch" variant="ghost">GitHub</LinkButton>
 */
import type { ComponentProps, ReactNode } from 'react';
import { Icon, type IconName } from '../icons';
import { Tooltip } from './Tooltip';
import { cx } from './util';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

interface ButtonLookProps {
  variant?: ButtonVariant;
  /** 'sm' is 28 px (inline actions, section heads). */
  size?: 'md' | 'sm';
  icon?: IconName;
  /** Keyboard hint drawn as a kbd chip after the label (hidden on phones). */
  kbd?: string;
  /** Stretch: 'wide' = 100% width, 'grow' = flex 1. */
  stretch?: 'wide' | 'grow';
}

function lookClass({ variant = 'secondary', size = 'md', stretch }: ButtonLookProps, extra?: string) {
  return cx('btn', variant !== 'secondary' && variant, size === 'sm' && 'sm', stretch, extra);
}

function Content({ icon, kbd, children }: { icon?: IconName; kbd?: string; children?: ReactNode }) {
  return (
    <>
      {icon && <Icon name={icon} />}
      {children}
      {kbd && (
        <kbd className="desk-only" aria-hidden="true">
          {kbd}
        </kbd>
      )}
    </>
  );
}

export interface ButtonProps extends ButtonLookProps, ComponentProps<'button'> {}

export function Button({ variant, size, icon, kbd, stretch, className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={lookClass({ variant, size, stretch }, className)} {...rest}>
      <Content icon={icon} kbd={kbd}>
        {children}
      </Content>
    </button>
  );
}

export interface LinkButtonProps extends ButtonLookProps, ComponentProps<'a'> {}

export function LinkButton({ variant, size, icon, kbd, stretch, className, children, ...rest }: LinkButtonProps) {
  return (
    <a className={lookClass({ variant, size, stretch }, className)} {...rest}>
      <Content icon={icon} kbd={kbd}>
        {children}
      </Content>
    </a>
  );
}

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  icon: IconName;
  /** Accessible name; also the tooltip text. */
  label: string;
  /** Shortcut shown in the tooltip, e.g. '⌘Z'. */
  shortcut?: string;
  variant?: Exclude<ButtonVariant, 'primary'>;
  size?: 'md' | 'sm';
  /** Toggle state (aria-pressed); omit for plain actions. */
  pressed?: boolean;
  tooltip?: boolean;
}

export function IconButton({
  icon,
  label,
  shortcut,
  variant = 'ghost',
  size = 'md',
  pressed,
  tooltip = true,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      type={type}
      className={cx(lookClass({ variant, size }), 'icon', className)}
      aria-label={label}
      aria-pressed={pressed}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
  return tooltip ? (
    <Tooltip label={label} shortcut={shortcut}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={className}>{children}</kbd>;
}
