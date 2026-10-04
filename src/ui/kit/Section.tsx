/**
 * Dock sections (spec §5): a 20 px head with an 11 px mono caps title and a right slot, hairline
 * below; and the 36 px disclosure row (collapsed sections such as Advanced) with a summary and a
 * chevron that turns 90° when open.
 *
 *   <Section title="Grid" aux={<><em>rows</em> 45 <em>auto</em></>} tab="adjust">…</Section>
 *   <Section title="Tone" action={<IconButton icon="reset" label="Reset tone" size="sm" />}>…</Section>
 *   <Disclosure title="Advanced" summary="Dither, font, cell, line height">…</Disclosure>
 *
 * `tab` tags the section for the phone sheet's Adjust / Glyphs / Color tabs (data-tab).
 */
import { useId, useState, type ReactNode } from 'react';
import { Icon } from '../icons';
import { cx } from './util';

export interface SectionProps {
  title: string;
  /** Right-slot text (12 px mono; wrap secondary words in <em>). */
  aux?: ReactNode;
  /** Right-slot control, e.g. a small reset IconButton. */
  action?: ReactNode;
  tab?: string;
  className?: string;
  children?: ReactNode;
}

export function Section({ title, aux, action, tab, className, children }: SectionProps) {
  const headId = useId();
  return (
    <section className={cx('sec', className)} data-tab={tab} aria-labelledby={headId}>
      <header className="sh">
        <h3 id={headId}>{title}</h3>
        {aux !== undefined && <span className="aux">{aux}</span>}
        {action}
      </header>
      {children}
    </section>
  );
}

export interface DisclosureProps {
  title: string;
  /** One-line summary shown on the right while collapsed (and open). */
  summary?: ReactNode;
  /** Set the summary in mono. */
  monoSummary?: boolean;
  /** Controlled state; omit to let the component keep its own. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(open: boolean): void;
  tab?: string;
  className?: string;
  children?: ReactNode;
}

export function Disclosure({
  title,
  summary,
  monoSummary,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  tab,
  className,
  children,
}: DisclosureProps) {
  const bodyId = useId();
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const open = openProp ?? ownOpen;
  const toggle = () => {
    setOwnOpen(!open);
    onOpenChange?.(!open);
  };
  return (
    <section className={cx('sec disc-sec', className)} data-tab={tab}>
      <h3 className="disc-h">
        <button type="button" className="disc" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
          <span className="t">{title}</span>
          {summary !== undefined && <span className={cx('aux', monoSummary && 'm')}>{summary}</span>}
          <Icon name="chev-r" />
        </button>
      </h3>
      <div id={bodyId} className="disc-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
