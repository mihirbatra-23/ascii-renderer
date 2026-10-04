/**
 * A sample tile (spec §4.1): a live 72 × 20 ASCII preview over a 44 px footer with icon, name,
 * mono meta and the 1–3 key. A button, because it performs an action; the art is decorative.
 */
import { memo, useEffect, useState } from 'react';
import { Icon } from '../icons';
import type { Sample } from './samples';
import { loadThumb, peekThumb, type Thumb } from './thumbs';

export interface SampleTileProps {
  sample: Sample;
  onOpen(sample: Sample): void;
}

export default function SampleTile({ sample, onOpen }: SampleTileProps) {
  return (
    <button
      type="button"
      className="tile"
      aria-label={`Open sample ${sample.name}, ${sample.meta}`}
      aria-keyshortcuts={sample.key}
      onClick={() => onOpen(sample)}
    >
      <SampleArt sample={sample} />
      <span className="tile-f">
        <Icon name={sample.icon} />
        <span className="n">{sample.name}</span>
        <span className="m">{sample.meta}</span>
        <kbd>{sample.key}</kbd>
      </span>
    </button>
  );
}

/**
 * The art box (a span: buttons only take phrasing content; `.art` sets white-space: pre) keeps its
 * 72 × 20 cell size while empty, so the page never shifts when the render lands.
 */
const SampleArt = memo(function SampleArt({ sample }: { sample: Sample }) {
  const [thumb, setThumb] = useState<Thumb | undefined>(() => peekThumb(sample));

  useEffect(() => {
    if (thumb) return;
    let live = true;
    loadThumb(sample).then(
      (t) => live && setThumb(t),
      // Without a thumbnail the tile still opens the sample; the paper stays blank.
      () => {},
    );
    return () => {
      live = false;
    };
  }, [sample, thumb]);

  return (
    <span className="art" aria-hidden="true" data-ready={thumb ? '' : undefined}>
      {thumb?.map((runs, r) => (
        <span key={r}>
          {runs.map((run, i) => (run.k ? <i key={i} className={`k${run.k}`}>{run.text}</i> : run.text))}
          {'\n'}
        </span>
      ))}
    </span>
  );
});
