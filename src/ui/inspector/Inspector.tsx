/**
 * The Adjust dock (design spec §4.2, §4.3): header with Presets and Reset all, then Mode, Grid,
 * Tone, Motion (GIF / video), Edges (Shape / Ramp), Glyphs, Color and a collapsed Advanced row.
 * Only the controls the current mode uses are shown.
 *
 * Phones get the same content in the bottom sheet, split by the Adjust / Glyphs / Color tabs:
 * `.db[data-tab]` shows only the sections tagged with the selected tab (shell.css), Mode moves to
 * the strip under the top bar, and Glyphs / Color are always full sections there.
 *
 * Every section subscribes to its own parameters, so a slider drag re-renders one row only.
 */
import { useEffect, useId, useRef } from 'react';
import { selectIsAnimated, useStore, type SheetTab } from '../../state/store';
import { PHONE_QUERY, Tabs, useMediaQuery } from '../kit';
import { AdvancedSection } from './AdvancedSection';
import { ColorDisclosure, ColorSection } from './ColorSection';
import { EdgesSection } from './EdgesSection';
import { GlyphsDisclosure, GlyphsSection } from './GlyphsSection';
import { GridSection } from './GridSection';
import { InspectorHeader } from './InspectorHeader';
import { ModeSection } from './ModeSection';
import { MotionSection } from './MotionSection';
import { ToneSection } from './ToneSection';
import './inspector.css';

const SHEET_TABS = [
  { id: 'adjust', label: 'Adjust' },
  { id: 'glyphs', label: 'Glyphs' },
  { id: 'color', label: 'Color' },
] as const satisfies readonly { id: SheetTab; label: string }[];

export default function Inspector() {
  const animated = useStore(selectIsAnimated);
  const tab = useStore((s) => s.ui.sheetTab);
  const phone = useMediaQuery(PHONE_QUERY);
  const bodyId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  // Video keeps Glyphs and Color as one-line rows on desktop, so Motion stays above the fold.
  const collapse = animated && !phone;

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [tab]);

  return (
    <>
      <InspectorHeader />
      {/* The desktop header (with its h2) is hidden on phones; the sections' h3s still need an h2 above them. */}
      {phone && <h2 className="sr">Adjust</h2>}
      <Tabs
        className="phone-only"
        label="Adjust panel"
        tabs={SHEET_TABS}
        value={tab}
        onChange={(t) => useStore.getState().setUi({ sheetTab: t })}
        panelId={bodyId}
      />
      <div
        ref={bodyRef}
        id={bodyId}
        className="db"
        data-tab={tab}
        role={phone ? 'tabpanel' : undefined}
        aria-label={phone ? SHEET_TABS.find((t) => t.id === tab)?.label : undefined}
      >
        <ModeSection />
        <GridSection />
        <ToneSection />
        {animated && <MotionSection />}
        <EdgesSection />
        {collapse ? <GlyphsDisclosure /> : <GlyphsSection />}
        {collapse ? <ColorDisclosure /> : <ColorSection />}
        <AdvancedSection />
      </div>
    </>
  );
}
