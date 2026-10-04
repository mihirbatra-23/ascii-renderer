/**
 * Whether the export will have a transparent background, for the stage's checker preview
 * (DESIGN_SPEC §4.4: "The transparent checker appears only when Transparent background is on").
 * True only while the Export panel is open, Transparent background is on and the selected format
 * and look can actually drop the paper (canBeTransparent), so the preview never promises
 * transparency the file will not have.
 */
import { useStore, type AppState } from '../../state/store';
import { canBeTransparent } from './sizing';

export const selectTransparentPreview = (s: AppState): boolean =>
  s.exportUi.open && s.exportUi.transparent && canBeTransparent(s.exportUi.format, s.params);

export function useTransparentPreview(): boolean {
  return useStore(selectTransparentPreview);
}
