/**
 * Theme switch: Graphite (variant A, the default) or Carbon (variant B). A two-option radiogroup
 * on the kit's segmented control; the choice lives in `ui.theme`, which the store persists and
 * app/hooks applies as `<html data-theme>`.
 *
 *   <ThemeToggle />          32 px, inside the Shortcuts sheet
 *   <ThemeToggle compact />  28 px, the start-screen footer
 */
import type { Theme } from '../../state/params';
import { useStore } from '../../state/store';
import { cx, Segmented, type SegmentedOption } from '../kit';
import './ThemeToggle.css';

const OPTIONS: readonly SegmentedOption<Theme>[] = [
  { value: 'a', label: <ThemeName theme="a" name="Graphite" />, ariaLabel: 'Graphite' },
  { value: 'b', label: <ThemeName theme="b" name="Carbon" />, ariaLabel: 'Carbon' },
];

function ThemeName({ theme, name }: { theme: Theme; name: string }) {
  return (
    <>
      <i className={`theme-chip ${theme}`} aria-hidden="true" />
      {name}
    </>
  );
}

export default function ThemeToggle({ compact }: { compact?: boolean }) {
  const theme = useStore((s) => s.ui.theme);
  const setTheme = useStore((s) => s.setTheme);
  return <Segmented label="Theme" options={OPTIONS} value={theme} onChange={setTheme} className={cx('theme-tg', compact && 'sm')} />;
}
