/**
 * The Shortcuts sheet (spec §10): every action in the shortcut registry, grouped, so it can never
 * drift from the keys that actually work (screens that add actions, such as the start screen's
 * 1–3, appear while they are mounted).
 *
 * Open state is `store.ui.shortcutsOpen`: the ? shortcut, the top bar and the start screen set it.
 * A centred dialog on desktop, a bottom sheet on phones (kit Dialog).
 */
import { formatCombo, useShortcuts, type ShortcutAction, type ShortcutGroup } from '../../app/shortcuts';
import { useStore } from '../../state/store';
import { Dialog } from '../kit';
import './ShortcutsOverlay.css';

// Ordered so the two desktop columns balance: File, Edit, View, General | Render, Playback, Start.
const GROUPS: readonly { group: ShortcutGroup; title?: string; aux?: string }[] = [
  { group: 'File' },
  { group: 'Edit' },
  { group: 'View' },
  { group: 'General' },
  { group: 'Render' },
  { group: 'Playback', aux: 'GIF and video' },
  { group: 'Start', title: 'Start screen' },
];

export default function ShortcutsOverlay() {
  const open = useStore((s) => s.ui.shortcutsOpen);
  const setUi = useStore((s) => s.setUi);
  return (
    <Dialog open={open} onClose={() => setUi({ shortcutsOpen: false })} title="Keyboard shortcuts" className="kb-sheet">
      <ShortcutList />
    </Dialog>
  );
}

function ShortcutList() {
  const actions = useShortcuts();
  return (
    <div className="kb-groups">
      {GROUPS.map(({ group, title = group, aux }) => {
        const list = actions.filter((a) => a.group === group);
        if (!list.length) return null;
        const headId = `kb-${group}`;
        return (
          <section key={group} className="kb-grp" aria-labelledby={headId}>
            <header className="sh">
              <h3 id={headId}>{title}</h3>
              {aux && (
                <span className="aux">
                  <em>{aux}</em>
                </span>
              )}
            </header>
            <dl>
              {list.map((a) => (
                <div key={a.id} className="kb-row">
                  <dt>{a.label}</dt>
                  <dd>
                    {shownCombos(a).map((k, i) => (
                      <span key={k} className="kb-alt">
                        {i > 0 && <span className="kb-or">or</span>}
                        <kbd>{formatCombo(k)}</kbd>
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
    </div>
  );
}

/** All combos except Shift variants of another listed key: labels already say "(Shift: 10)". */
function shownCombos(action: ShortcutAction): readonly string[] {
  return action.keys.filter((k) => !(k.startsWith('shift+') && action.keys.includes(k.slice(6))));
}
