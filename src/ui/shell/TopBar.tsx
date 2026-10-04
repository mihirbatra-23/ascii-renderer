/**
 * Top bar (spec §2): wordmark | source chip (icon, name, mono meta, close ×) … undo / redo |
 * GitHub · Open ⌘O (with a menu of the other ways in: paste, camera) · Export ⌘E (the screen's one
 * primary action, aria-expanded while open).
 *
 * Phones keep the wordmark, an Open icon button and Export, plus a ⋯ button for everything the
 * desktop shows elsewhere (undo, presets, view, zoom, camera, shortcuts, theme: PhoneMenu).
 */
import { cameraAvailable, closeMedia, openCamera } from '../../app/controller';
import { shortcutLabel } from '../../app/shortcuts';
import { selectCanRedo, selectCanUndo, selectHasMedia, useStore, type MediaInfo } from '../../state/store';
import { Icon } from '../icons';
import { Button, IconButton, LinkButton, MenuButton, Tooltip, type MenuEntry } from '../kit';
import { dims, formatBytes, formatFps } from '../stage/format';
import { pasteAndOpen, pickAndOpen } from '../start/openers';
import { REPO_URL } from '../start/samples';
import PhoneMenu from './PhoneMenu';

export default function TopBar() {
  return (
    <header className="top">
      <PageHeading />
      <Wordmark />
      <span className="vr desk-only" />
      <SourceChip />
      <span className="sp" />
      <History />
      <span className="vr desk-only" />
      <div className="acts">
        <Tooltip label="GitHub repository">
          <LinkButton variant="ghost" icon="branch" className="gh desk-only" href={REPO_URL} target="_blank" rel="noreferrer" aria-label="GitHub repository">
            <span className="lbl-opt" aria-hidden="true">
              GitHub
            </span>
          </LinkButton>
        </Tooltip>
        <OpenGroup />
        <IconButton className="phone-only" variant="secondary" icon="folder" label="Open file" onClick={pickAndOpen} />
        <ExportButton />
        <PhoneMenu />
      </div>
    </header>
  );
}

/** The editor's page heading for assistive tech (the wordmark and file chip are its visual form). */
function PageHeading() {
  const name = useStore((s) => s.media.info?.name);
  return <h1 className="sr">{name ? `${name} · ASCII Renderer` : 'ASCII Renderer'}</h1>;
}

function Wordmark() {
  return (
    <a
      className="wm"
      href="./"
      aria-label="ASCII Renderer home"
      onClick={(e) => {
        e.preventDefault();
        closeMedia();
      }}
    >
      <span className="wm-a">ASCII</span>
      <span className="wm-b">Renderer</span>
    </a>
  );
}

/** Open ⌘O picks a file in one click; the attached chevron lists the other ways in. */
function OpenGroup() {
  const items: MenuEntry[] = [
    { id: 'file', label: 'Choose a file…', aux: shortcutLabel('file.open'), onSelect: pickAndOpen },
    { id: 'paste', label: 'Paste from clipboard', aux: shortcutLabel('file.paste'), onSelect: pasteAndOpen },
  ];
  if (cameraAvailable()) items.push({ id: 'camera', label: 'Camera', aux: 'Live', onSelect: () => void openCamera() });
  return (
    <div className="open-split desk-only" role="group" aria-label="Open">
      <Button icon="folder" kbd={shortcutLabel('file.open')} onClick={pickAndOpen}>
        Open
      </Button>
      <MenuButton label="" ariaLabel="More ways to open" items={items} variant="secondary" size="md" align="end" className="open-more" />
    </div>
  );
}

function SourceChip() {
  const info = useStore((s) => s.media.info);
  if (!info) return null;
  const close = info.live ? 'Stop the camera' : `Close ${info.name}`;
  return (
    <div className="src">
      <Icon name={info.live ? 'camera' : info.kind === 'image' ? 'image' : 'film'} />
      <span className="src-name" title={info.name}>
        {info.name}
      </span>
      {info.live && (
        <span className="live-badge">
          <i aria-hidden="true" />
          Live
        </span>
      )}
      <span className="src-meta">
        <Meta info={info} />
      </span>
      <IconButton icon="x" size="sm" label={close} onClick={closeMedia} />
    </div>
  );
}

/** "1280 × 720 · PNG · 412 KB"; clips add fps and duration; a camera only its size and rate. The tail drops at ≤ 1280 px. */
function Meta({ info }: { info: MediaInfo }) {
  const head = info.live ? [] : [info.formatLabel];
  const tail: string[] = [];
  if (info.kind === 'video' && info.fps) head.push(formatFps(info.fps));
  if (info.kind === 'animation' && info.frameCount) head.push(`${info.frameCount} fr`);
  if (info.durationSec) tail.push(`${info.durationSec.toFixed(2)} s`);
  if (!info.live) tail.push(formatBytes(info.fileSize));
  return (
    <>
      <b>{dims(info.width, info.height)}</b>
      {head.map((t) => (
        <Dot key={t}>{t}</Dot>
      ))}
      <span className="opt">
        {tail.map((t) => (
          <Dot key={t}>{t}</Dot>
        ))}
      </span>
    </>
  );
}

function Dot({ children }: { children: string }) {
  return (
    <>
      <span className="dotsep" />
      {children}
    </>
  );
}

function History() {
  const canUndo = useStore(selectCanUndo);
  const canRedo = useStore(selectCanRedo);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  return (
    <div className="acts desk-only">
      <IconButton icon="undo" label="Undo" shortcut={shortcutLabel('edit.undo')} disabled={!canUndo} onClick={undo} />
      <IconButton icon="redo" label="Redo" shortcut={shortcutLabel('edit.redo')} disabled={!canRedo} onClick={redo} />
    </div>
  );
}

function ExportButton() {
  const ready = useStore(selectHasMedia);
  const expanded = useStore((s) => s.exportUi.open);
  const setExportUi = useStore((s) => s.setExportUi);
  return (
    <Button
      variant="primary"
      icon="export"
      kbd={shortcutLabel('export.toggle')}
      aria-expanded={expanded}
      disabled={!ready}
      onClick={() => setExportUi({ open: !expanded })}
    >
      Export
    </Button>
  );
}
