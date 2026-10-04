/**
 * Edges (Shape and Ramp only): the edge layer draws contour strokes (| / \ _ −) over the fill
 * where the image has strong edges, and the threshold sets how strong an edge must be to get
 * one. The threshold stays in place, disabled, while the layer is off, so switching it does not
 * shift the dock. Braille, Blocks and Halftone draw their own marks, so the section is hidden.
 */
import { useStore } from '../../state/store';
import { Section } from '../kit';
import { ParamSlider, ParamSwitch } from './controls';
import { hasEdgeLayer } from './copy';

export function EdgesSection() {
  const mode = useStore((s) => s.params.mode);
  const edges = useStore((s) => s.params.edges);
  if (!hasEdgeLayer(mode)) return null;
  return (
    <Section
      title="Edges"
      tab="adjust"
      aux={
        <>
          <em>strokes</em> {'/|\\_'}
        </>
      }
    >
      <ParamSwitch param="edges" label="Contour lines" sub="Strokes along strong edges, over the fill" />
      <div className="rows">
        <ParamSlider param="edgeThreshold" label="Threshold" disabled={!edges} />
      </div>
    </Section>
  );
}
