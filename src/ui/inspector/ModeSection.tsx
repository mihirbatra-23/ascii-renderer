/**
 * Mode (desktop only; phones get the mode strip under the top bar): five tiles and a one-line hint
 * for the selected mode. M cycles modes (Shortcuts sheet).
 */
import { useStore } from '../../state/store';
import { ModeTiles, Section } from '../kit';
import { store } from './controls';
import { MODE_HINTS } from './copy';

export function ModeSection() {
  const mode = useStore((s) => s.params.mode);
  return (
    <Section title="Mode" className="desk-only">
      <ModeTiles value={mode} onChange={(m) => store().setParam('mode', m)} />
      <p className="hint">{MODE_HINTS[mode]}</p>
    </Section>
  );
}
