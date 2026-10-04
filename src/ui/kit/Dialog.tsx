/**
 * Modal dialog on the native <dialog> (focus trap, Escape, inert background for free): a centred
 * card on desktop, a bottom sheet on phones. Used for the Shortcuts sheet, the preset dialogs and
 * the close-file confirmation.
 *
 *   <Dialog open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts">…</Dialog>
 *   <Dialog … title="Save preset" footer={<><Button …>Cancel</Button><Button type="submit" form={id} …>Save</Button></>}>
 *   <Dialog … role="alertdialog" header={false} labelledBy={titleId} describedBy={textId} className="confirm-dlg" footer={…}>
 *
 * `footer` renders the shared action row (.dlg-f: 48 px, hairline above, actions on the right).
 * `header={false}` drops the title bar and its × (a confirmation names itself in the body).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { IconButton } from './Button';
import { cx } from './util';

export interface DialogProps {
  open: boolean;
  onClose(): void;
  /** Title bar text; also the accessible name unless `labelledBy` is set. */
  title: string;
  /** Extra header content between the title and the close button. */
  headerExtra?: ReactNode;
  /** Show the title bar with its close button (default true). */
  header?: boolean;
  /** Action row under the body. */
  footer?: ReactNode;
  role?: 'dialog' | 'alertdialog';
  /** Ids of the elements that name and describe the dialog (instead of aria-label={title}). */
  labelledBy?: string;
  describedBy?: string;
  className?: string;
  children?: ReactNode;
}

export function Dialog({ open, onClose, title, headerExtra, header = true, footer, role, labelledBy, describedBy, className, children }: DialogProps) {
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
      role={role === 'alertdialog' ? role : undefined}
      aria-label={labelledBy ? undefined : title}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={(e) => {
        // Keep `open` owned by the caller: Escape asks to close instead of closing directly.
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      {open && (
        <>
          {header && (
            <div className="dlg-h">
              <h2>{title}</h2>
              {headerExtra}
              <IconButton icon="x" label="Close" size="sm" tooltip={false} onClick={onClose} />
            </div>
          )}
          <div className="dlg-b">{children}</div>
          {footer !== undefined && <div className="dlg-f">{footer}</div>}
        </>
      )}
    </dialog>
  );
}
