/**
 * Motion (GIF, video and camera only): temporal stability (ALGORITHM §8). The output frame rate
 * is set where it applies, in the Export panel.
 */
import { Section } from '../kit';
import { ParamSlider } from './controls';
import { TIPS } from './copy';

export function MotionSection() {
  return (
    <Section title="Motion" tab="adjust">
      <div className="rows">
        <ParamSlider param="stability" label="Stability" tooltip={TIPS.stability} />
      </div>
    </Section>
  );
}
