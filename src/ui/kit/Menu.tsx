/**
 * Menu button (e.g. the dock's Presets menu): a 32 px secondary Button (by default) with a chevron that opens a role="menu"
 * popover. ↓ ↑ Home End move focus, Enter / Space activate, Escape / Tab close.
 *
 *   <MenuButton label="Presets" items={[{ heading: 'Built-in' }, { id: 'line-art', label: 'Line art', onSelect }, 'separator', …]} />
 */
import { Fragment, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../icons';
import { Button, type ButtonVariant } from './Button';
import { Popover } from './Popover';

export interface MenuItem {
  id: string;
  label: string;
  onSelect(): void;
  /** Right-aligned mono note. */
  aux?: string;
  disabled?: boolean;
  /** A line under the item (e.g. why it is disabled); also its accessible description. */
  note?: string;
  /** Set for radio-like items: renders a check and role="menuitemradio". */
  checked?: boolean;
  /** Adds a small delete button at the right of the row (e.g. a saved preset). */
  onDelete?(): void;
  /** Accessible name of that button (default "Delete {label}"). */
  deleteLabel?: string;
}

export type MenuEntry = MenuItem | 'separator' | { heading: string };

export interface MenuButtonProps {
  label: ReactNode;
  items: readonly MenuEntry[];
  /** Accessible name when the label is not text. */
  ariaLabel?: string;
  icon?: IconName;
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  align?: 'start' | 'end';
  /** Width of the menu in px (default 240). */
  width?: number;
  className?: string;
}

const ITEM = '[role^="menuitem"]:not([aria-disabled="true"])';

export function MenuButton({ label, items, ariaLabel, icon, variant = 'secondary', size = 'md', align = 'end', width, className }: MenuButtonProps) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusLast = useRef(false);
  const menuId = useId();

  const close = (focusTrigger: boolean) => {
    setOpen(false);
    if (focusTrigger) anchor?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const all = menuRef.current?.querySelectorAll<HTMLElement>(ITEM);
    all?.[focusLast.current ? all.length - 1 : 0]?.focus();
  }, [open]);

  const openMenu = (last = false) => {
    focusLast.current = last;
    setOpen(true);
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(ITEM));
    const i = all.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = (i + 1) % all.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + all.length) % all.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = all.length - 1;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    all[next]?.focus();
  };

  return (
    <>
      <Button
        ref={setAnchor}
        variant={variant}
        size={size}
        icon={icon}
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            openMenu(e.key === 'ArrowUp');
          }
        }}
      >
        {label}
        <Icon name="chev-d" />
      </Button>
      <Popover anchor={anchor} open={open} onClose={close} align={align}>
        <div ref={menuRef} className="menu" role="menu" style={width ? { width } : undefined} onKeyDown={onMenuKey}>
          {items.map((entry, i) => {
            if (entry === 'separator') return <hr key={`sep-${i}`} />;
            if ('heading' in entry)
              return (
                <div key={`h-${entry.heading}`} className="mh" role="presentation">
                  {entry.heading}
                </div>
              );
            const radio = entry.checked !== undefined;
            const noteId = entry.note ? `${menuId}-${entry.id}-note` : undefined;
            // The aux is a description, not part of the name, so the name is what the label says.
            const auxId = entry.aux ? `${menuId}-${entry.id}-aux` : undefined;
            const describedBy = [auxId, noteId].filter(Boolean).join(' ') || undefined;
            const item = (
              <button
                key={entry.id}
                type="button"
                role={radio ? 'menuitemradio' : 'menuitem'}
                aria-checked={radio ? entry.checked : undefined}
                aria-disabled={entry.disabled || undefined}
                aria-describedby={describedBy}
                tabIndex={-1}
                onClick={() => {
                  if (entry.disabled) return;
                  close(true);
                  entry.onSelect();
                }}
              >
                {radio && <span className="ck">{entry.checked && <Icon name="check" />}</span>}
                <span className="nm">{entry.label}</span>
                {entry.aux && (
                  <small id={auxId} aria-hidden="true">
                    {entry.aux}
                  </small>
                )}
              </button>
            );
            if (entry.onDelete) {
              const onDelete = entry.onDelete;
              return (
                <div key={entry.id} className="mrow">
                  {item}
                  <button
                    type="button"
                    role="menuitem"
                    className="mdel"
                    tabIndex={-1}
                    aria-label={entry.deleteLabel ?? `Delete ${entry.label}`}
                    title="Delete"
                    onClick={() => {
                      close(true);
                      onDelete();
                    }}
                  >
                    <Icon name="x" />
                  </button>
                </div>
              );
            }
            if (!entry.note) return item;
            return (
              <Fragment key={entry.id}>
                {item}
                <p id={noteId} className="mnote">
                  {entry.note}
                </p>
              </Fragment>
            );
          })}
        </div>
      </Popover>
    </>
  );
}
