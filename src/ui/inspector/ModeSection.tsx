/**
 * Mode (desktop only; phones get the mode strip under the top bar): five tiles and a one-line hint,
 * which also mentions the edge layer while it is on.
 */
import { useStore } from '../../state/store';
import { ModeTiles, Section } from '../kit';
import { store } from './controls';
import { MODE_HINTS, MODE_HINTS_WITH_EDGES } from './copy';

export function ModeSection() {
  const mode = useStore((s) => s.params.mode);
  const edges = useStore((s) => s.params.edges);
  const hint = (edges && MODE_HINTS_WITH_EDGES[mode]) || MODE_HINTS[mode];
  return (
    <Section
      title="Mode"
      className="desk-only"
      aux={
        <span className="kbd-hint">
          <kbd>M</kbd>
          <em>to cycle</em>
        </span>
      }
    >
      <ModeTiles value={mode} onChange={(m) => store().setParam('mode', m)} />
      <p className="hint">{hint}</p>
    </Section>
  );
}
