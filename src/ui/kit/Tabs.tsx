/**
 * Tabs (spec §5, phone sheet): 44 px, equal widths, the selected tab gets `--tx-1` and a 2 px
 * accent underline. role="tablist" with arrow keys and one tab stop.
 *
 *   <Tabs label="Panel" value={tab} onChange={setTab} panelId="dock-body"
 *         tabs={[{ id: 'adjust', label: 'Adjust' }, { id: 'glyphs', label: 'Glyphs' }, { id: 'color', label: 'Color' }]} />
 */
import { onRovingKeyDown, rovingTabIndex } from './radio';
import { cx } from './util';

export interface TabsProps<T extends string> {
  tabs: readonly { id: T; label: string }[];
  value: NoInfer<T>;
  onChange(id: NoInfer<T>): void;
  label: string;
  /** id of the element the tabs control. */
  panelId?: string;
  className?: string;
}

export function Tabs<const T extends string>({ tabs, value, onChange, label, panelId, className }: TabsProps<T>) {
  return (
    <div className={cx('tabs', className)} role="tablist" aria-label={label} onKeyDown={(e) => onRovingKeyDown(e, '[role="tab"]')}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === value}
          aria-controls={panelId}
          tabIndex={rovingTabIndex(t.id === value, i, true)}
          onClick={() => t.id !== value && onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
