/**
 * Start screen (spec §4.1, a-start / a-start-phone): header, headline, drop zone, three live
 * sample tiles (keys 1–3) and a footer with the version and the privacy line. The header and footer
 * are sticky; the page scrolls between them. Shown while nothing is open; the window-wide drop and
 * ⌘V paste are App-level (app/hooks).
 */
import { useEffect } from 'react';
import { openSample } from '../../app/controller';
import { linkLookUnedited } from '../../app/permalink';
import { registerShortcut } from '../../app/shortcuts';
import { defaultParams } from '../../state/params';
import { useStore } from '../../state/store';
import { Icon } from '../icons';
import { Button, LinkButton, toast, Tooltip } from '../kit';
import DropZone from './DropZone';
import SampleTile from './SampleTile';
import { APP_VERSION, REPO_URL, SAMPLES, type Sample } from './samples';
import './start.css';

/**
 * The editor opens in the look the tile shows (one undo entry), except while a settings link's look
 * is in place and unedited: the recipient came to see that look, so the sample shows it instead.
 * A look that replaces settings the user had changed says so, with Undo.
 */
function open(sample: Sample) {
  if (!linkLookUnedited()) {
    const { params: before, setParams } = useStore.getState();
    const defaults = defaultParams();
    const replaces = (Object.keys(sample.look) as (keyof typeof sample.look)[]).some(
      (k) => before[k] !== sample.look[k] && before[k] !== defaults[k],
    );
    setParams(sample.look);
    if (replaces) {
      toast({
        icon: 'check',
        title: `Applied settings from ${sample.name}`,
        body: 'Mode, tone, glyphs and edges now match the sample. Other settings are unchanged.',
        trailing: { label: 'Undo', onClick: () => useStore.getState().setParams(before) },
      });
    }
  }
  void openSample(sample.url, sample.name);
}

export default function StartScreen() {
  useEffect(
    () =>
      registerShortcut({
        id: 'start.sample',
        label: 'Open a sample',
        group: 'Start',
        keys: SAMPLES.map((s) => s.key),
        enabled: () => useStore.getState().media.status === 'empty',
        handler: (e) => {
          const sample = SAMPLES.find((s) => s.key === e.key);
          if (sample) open(sample);
        },
      }),
    [],
  );

  return (
    <div className="spg">
      <StartHeader />
      <main className="start">
        <div className="hero">
          <h1>
            Images, GIFs and video,
            <br />
            rendered in <span className="type">type.</span>
          </h1>
          <p>
            Match each cell of your image or video to the glyph with the closest shape and export it as an image, text or video
            without leaving your browser.
          </p>
        </div>
        <DropZone />
        <section className="samples" aria-labelledby="h-samples">
          <header className="sh">
            <h2 id="h-samples">Samples</h2>
          </header>
          <div className="tiles">
            {SAMPLES.map((s) => (
              <SampleTile key={s.key} sample={s} onOpen={open} />
            ))}
          </div>
        </section>
      </main>
      <StartFooter />
    </div>
  );
}

function StartHeader() {
  const setUi = useStore((s) => s.setUi);
  return (
    <header className="top">
      <span className="wm">
        <span className="wm-a">ASCII</span>
        <span className="wm-b">Renderer</span>
      </span>
      <span className="sp" />
      <Button variant="ghost" icon="keyboard" kbd="?" className="desk-only" aria-haspopup="dialog" onClick={() => setUi({ shortcutsOpen: true })}>
        Shortcuts
      </Button>
      <Tooltip label="GitHub repository">
        <LinkButton
          variant="ghost"
          icon="github"
          className="gh"
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GitHub repository (opens in a new tab)"
        >
          <span className="lbl-opt">GitHub</span>
        </LinkButton>
      </Tooltip>
    </header>
  );
}

function StartFooter() {
  return (
    <footer className="sfoot">
      <span className="lic">
        ASCII Renderer <span className="mono">v{APP_VERSION}</span>
      </span>
      <span className="sp" />
      <span className="lock">
        <Icon name="lock" size={14} />
        Files stay on your device
      </span>
    </footer>
  );
}
