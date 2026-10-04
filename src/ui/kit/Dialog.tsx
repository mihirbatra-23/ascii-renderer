/**
 * Modal dialog on the native <dialog> (focus trap, Escape, inert background for free): a centred
 * card on desktop, a bottom sheet on phones. Used for the Shortcuts sheet.
 *
 *   <Dialog open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts">…</Dialog>
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { IconButton } from './Button';
import { cx } from './util';

export interface DialogProps {
  open: boolean;
  onClose(): void;
  title: string;
  /** Extra header content between the title and the close button. */
  headerExtra?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export function Dialog({ open, onClose, title, headerExtra, className, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={cx('dialog', className)}
      aria-label={title}
      onCancel={(e) => {
        // Keep `open` owned by the caller: Escape asks to close instead of closing directly.
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      {open && (
        <>
          <div className="dlg-h">
            <h2>{title}</h2>
            {headerExtra}
            <IconButton icon="x" label="Close" size="sm" tooltip={false} onClick={onClose} />
          </div>
          <div className="dlg-b">{children}</div>
        </>
      )}
    </dialog>
  );
}
