/**
 * Editor drag-over (spec §5 "Drop zone and empty state"): a dashed accent frame 10 px inside the
 * stage over --g0 at 70 %, with a pill saying what will happen. The window-wide listeners live in
 * app/hooks.ts (useWindowFileDrop); unsupported drags were refused on dragenter, so they draw
 * nothing here (no accent, not-allowed cursor).
 */
import { useStore } from '../../state/store';
import { Icon } from '../icons';

export default function DropOverlay() {
  const drag = useStore((s) => s.ui.dragOver);
  const current = useStore((s) => s.media.info?.name);
  if (!drag?.supported) return null;
  const what = drag.name ? ` with ${drag.name}` : '';
  return (
    <div className="drop-ov" aria-hidden="true">
      <div className="pill">
        <Icon name="upload" />
        {current ? `Drop to replace ${current}${what}` : `Drop to open${drag.name ? ` ${drag.name}` : ''}`}
      </div>
    </div>
  );
}
