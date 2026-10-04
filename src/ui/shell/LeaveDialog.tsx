/**
 * "Close torus.png?" before going back to the start screen (copy rows cf-01 to cf-04). Back, the
 * wordmark and the phone menu's Close file / Stop camera all call requestLeave(), which opens this
 * whenever a source is loaded (samples included). Only while a file is still opening does it go
 * back at once, since there is nothing to lose yet.
 *
 * An alertdialog on the kit Dialog with no title bar. Focus starts on Cancel; Enter confirms
 * (unless the user tabbed onto Cancel, where Enter presses it), Esc and Cancel return focus to Back.
 * Closing keeps the settings: closeMedia resets only playback, the view and the export panel.
 */
import { useEffect } from 'react';
import { closeMedia } from '../../app/controller';
import { useStore } from '../../state/store';
import { Button, Dialog } from '../kit';

export function requestLeave(): void {
  const { media, setUi } = useStore.getState();
  if (media.info && media.status !== 'loading') setUi({ leaveOpen: true });
  else void leave();
}

async function leave(): Promise<void> {
  const { job, setUi } = useStore.getState();
  setUi({ leaveOpen: false });
  // The export code is loaded on demand; a job can only be running once it has been.
  if (job.status === 'running') (await import('../export/exportJob')).cancelExport();
  closeMedia();
}

function cancel(): void {
  useStore.getState().setUi({ leaveOpen: false });
  // After the dialog has closed (the browser restores focus first, to the More sheet's button on phones).
  requestAnimationFrame(() => document.querySelector<HTMLElement>('.top .back')?.focus());
}

export default function LeaveDialog() {
  const open = useStore((s) => s.ui.leaveOpen);
  const info = useStore((s) => s.media.info);
  const live = info?.live === true;
  const shown = open && !!info;

  // Enter is the dialog's default action, wherever focus is, except on Cancel reached with Tab.
  useEffect(() => {
    if (!shown) return;
    let tabbed = false;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target?.closest('.confirm-dlg')) return;
      if (e.key === 'Tab') tabbed = true;
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return;
      if (tabbed && target.matches('.dlg-f > .btn:first-child')) return;
      e.preventDefault();
      void leave();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [shown]);

  return (
    <Dialog
      open={shown}
      onClose={cancel}
      title={live ? 'Stop the camera?' : `Close ${info?.name ?? 'file'}?`}
      header={false}
      role="alertdialog"
      labelledBy="leave-t"
      describedBy="leave-d"
      className="confirm-dlg"
      footer={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button variant="primary" onClick={() => void leave()}>
            {live ? 'Stop camera' : 'Close file'}
          </Button>
        </>
      }
    >
      <h2 id="leave-t" className="dlg-ti" title={live ? undefined : info?.name}>
        {live ? 'Stop the camera?' : `Close ${info?.name}?`}
      </h2>
      <p id="leave-d" className="dlg-t">
        {live
          ? 'This turns the camera off and returns to the start screen. Your settings stay. Record first to keep this take.'
          : 'This returns to the start screen. Your settings stay, so the next file opens with them. Export first to keep this render.'}
      </p>
    </Dialog>
  );
}
