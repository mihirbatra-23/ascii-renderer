/**
 * Motion (GIF and video only): temporal stability (ALGORITHM §8) and, for video, the frame rate
 * GIF / MP4 / WebM exports are written at (`exportUi.fps`, the same value as the Export panel's
 * row). A GIF source keeps its own per-frame timing in every export, and a live camera is
 * recorded at the rate it delivers, so neither offers a rate that would not be honoured.
 */
import { selectIsLive, useStore } from '../../state/store';
import { Section, Segmented } from '../kit';
import { LabelledRow, ParamSlider, store } from './controls';

export function MotionSection() {
  const kind = useStore((s) => s.media.info?.kind);
  const live = useStore(selectIsLive);
  return (
    <Section title="Motion" tab="adjust" aux={<em>GIF and video only</em>}>
      <div className="rows">
        <ParamSlider param="stability" label="Stability" />
        {kind === 'video' && !live && <OutputFpsRow />}
      </div>
      {kind === 'animation' && <p className="hint">Exports keep the GIF’s own frame timing.</p>}
    </Section>
  );
}

function OutputFpsRow() {
  const fps = useStore((s) => s.exportUi.fps);
  const sourceFps = useStore((s) => s.media.info?.fps);
  const src = sourceFps ? Math.round(sourceFps) : null;
  return (
    <LabelledRow label="Output fps">
      {(id) => (
        <Segmented<number | 'source'>
          full
          variant="mono"
          labelledBy={id}
          value={fps}
          onChange={(v) => store().setExportUi({ fps: v })}
          options={[
            { value: 12, label: '12' },
            { value: 15, label: '15' },
            { value: 30, label: '30' },
            {
              value: 'source',
              label: src ? `Src ${src}` : 'Src',
              ariaLabel: src ? `Source rate, ${src} fps` : 'Source rate',
            },
          ]}
        />
      )}
    </LabelledRow>
  );
}
