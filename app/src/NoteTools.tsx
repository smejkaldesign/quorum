import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Backlink, NoteViews, OutLink, SearchHit } from './quorum';
import { headingText, slugsOf, useCopyLink } from './HeadingLinks';
import { agentName } from './ViewsPill';
import { IconBack, IconChevron, IconExternal, IconLink, IconSearch } from './icons';

// Right-hand panel beside an open note: what links here, what it links to, and its headings; children (the note's
// versions in the Memory tab) come last
// one link per row, on one line; the open icon shows on hover and the text gives it room
function LinkRow({ title, tip, className = '', onClick }: { title: string; tip?: string; className?: string; onClick: () => void }) {
  return (
    <button className={`np-item np-link ${className}`} onClick={onClick} data-tip={tip} data-tip-pos="left">
      <strong>{title}</strong><IconExternal width={13} height={13} />
    </button>
  );
}

// an outline entry scrolls the note to its heading: the nth heading with that text in the open note
function toHeading(text: string, nth: number) {
  const plain = (s: string) => s.replace(/[*_`#[\]]/g, '').trim().toLowerCase();
  const hits = [...document.querySelectorAll<HTMLElement>('.kb-preview .doc h1, .kb-preview .doc h2, .kb-preview .doc h3, .kb-preview .doc h4')].filter((h) => plain(headingText(h)) === plain(text));
  (hits[nth] ?? hits[0])?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function NotePanel({ rel, body, previous, onOpen, onResolve, views = null, children }: {
  previous?: { rel: string; title: string } | null; rel: string; body: string; onOpen: (rel: string) => void; onResolve: (target: string) => void; views?: NoteViews | null; children?: ReactNode;
}) {
  const [back, setBack] = useState<Backlink[]>([]);
  const [out, setOut] = useState<OutLink[]>([]);
  useEffect(() => {
    let live = true;
    Promise.all([window.quorum.vaultBacklinks(rel), window.quorum.vaultOutgoing(rel)]).then(([b, o]) => { if (live) { setBack(b); setOut(o); } });
    return () => { live = false; };
  }, [rel, body]);
  const outline = useMemo(() => body.split('\n').map((l) => l.match(/^(#{1,4})\s+(.+)$/)).filter(Boolean).map((m) => ({ level: m![1].length, text: m![2] })), [body]);
  const slugs = useMemo(() => slugsOf(outline.map((h) => h.text)), [outline]);
  const uniqueOut = useMemo(() => [...new Map(out.map((o) => [o.rel ?? `?${o.target}`, o])).values()], [out]);
  const { copied, copy } = useCopyLink();
  const base = `quorum://note/${encodeURIComponent(rel)}`;

  return (
    <aside className="note-panel" aria-label="Outline, versions and links">
      {previous && previous.rel !== rel && (
        <button className="np-item np-link np-prev" onClick={() => onOpen(previous.rel)} data-tip={`Back to ${previous.title}`} data-tip-pos="left">
          <IconBack width={13} height={13} /><span className="np-prev-label">Previous memory</span><strong>{previous.title}</strong>
        </button>
      )}
      <Section title="Outline" count={outline.length}>
        {outline.length ? outline.map((h, i) => {
          const nth = outline.slice(0, i).filter((x) => x.text === h.text).length;
          const url = `${base}#${slugs[i]}`;
          return (
            <div key={i} className="np-outline-row">
              <button className="np-outline" onClick={() => toHeading(h.text, nth)}>{h.text.replace(/[*_`]/g, '')}</button>
              <button className="np-anchor" aria-label="Copy a link to this heading" data-tip={copied === url ? 'Link copied' : 'Copy link to this heading'} data-tip-pos="left" onClick={() => copy(url)}><IconLink width={13} height={13} /></button>
            </div>
          );
        }) : <p className="np-empty">No headings.</p>}
      </Section>
      {children}
      {/* links between notes in this vault: notes that link here, and notes this one links to */}
      <Section title="Linked from" count={back.length}>
        {back.length ? back.map((b, i) => <LinkRow key={`${b.rel}-${i}`} title={b.title} tip={b.context ? b.context.slice(0, 140) : undefined} onClick={() => onOpen(b.rel)} />)
          : <p className="np-empty">No notes link here yet.</p>}
      </Section>
      <Section title="Links to" count={uniqueOut.length}>
        {uniqueOut.length ? uniqueOut.map((o) => (
          <LinkRow key={o.rel ?? o.target} title={o.title} className={o.rel ? '' : 'unresolved'} tip={o.rel ? undefined : 'No note with this name yet'} onClick={() => (o.rel ? onOpen(o.rel) : onResolve(o.target))} />
        )) : <p className="np-empty">This note links to no other notes.</p>}
      </Section>
      <Section title="Views" count={views?.total ?? 0}>
        {views?.total ? <>
          <div className="views-row"><span>People</span><strong>{views.human}</strong></div>
          <div className="views-row"><span>Agents</span><strong>{views.agent}</strong></div>
          {views.agents.map((a) => <div key={a.via} className="views-row sub"><span>{agentName(a.via)}</span><strong>{a.count}</strong></div>)}
        </> : <p className="np-empty">Nobody has read it in Quorum yet.</p>}
      </Section>
    </aside>
  );
}

// a section of the panel; one with nothing in it starts closed
export function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(count > 0);
  return (
    <section className="np-section">
      <button className="np-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <IconChevron className={open ? '' : 'closed'} />{title}<em>{count}</em>
      </button>
      {open && <div className="np-body">{children}</div>}
    </section>
  );
}

export type PaletteItem = { id: string; label: string; hint?: string; run: () => void };

// one overlay for the quick switcher (⌘O), full-text search (⌘⇧F) and the command palette (⌘P)
export type PaletteMode = 'switcher' | 'search' | 'palette' | 'move';

export function Palette({ mode, notes, commands, onOpen, onCreate, onClose, scope, folders, onMove }: {
  mode: PaletteMode; notes: string[]; commands: PaletteItem[];
  onOpen: (rel: string) => void; onCreate: (name: string) => void; onClose: () => void;
  scope?: string; folders?: string[]; onMove?: (folder: string) => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    if (mode !== 'search' || q.trim().length < 2) { setHits([]); return; }
    let live = true;
    const t = setTimeout(() => window.quorum.vaultSearch(q, scope ? 1000 : 30).then((h) => { if (live) setHits(scope ? h.filter((x) => x.rel.startsWith(`${scope}/`)).slice(0, 40) : h); }), 120);
    return () => { live = false; clearTimeout(t); };
  }, [q, mode, scope]);

  const items: PaletteItem[] = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const fits = (s: string) => words.every((w) => s.toLowerCase().includes(w));
    if (mode === 'palette') return commands.filter((c) => fits(c.label));
    if (mode === 'move') return ['', ...(folders ?? [])].filter((f) => fits(f || 'vault root')).slice(0, 60)
      .map((f) => ({ id: `dir:${f}`, label: f ? f.split('/').pop()! : 'Vault root', hint: f || 'Top level of the vault', run: () => onMove?.(f) }));
    if (mode === 'search') return hits.map((h) => ({ id: h.rel, label: h.title, hint: h.snippet || h.rel, run: () => onOpen(h.rel) }));
    const found = notes.filter((rel) => fits(rel)).sort((a, b) => a.length - b.length).slice(0, 40)
      .map((rel) => ({ id: rel, label: rel.split('/').pop()!.replace(/\.md$/, ''), hint: rel.split('/').slice(0, -1).join('/'), run: () => onOpen(rel) }));
    if (q.trim() && !found.some((f) => f.label.toLowerCase() === q.trim().toLowerCase())) {
      found.push({ id: '+new', label: `Create "${q.trim()}"`, hint: 'New note', run: () => onCreate(q.trim()) });
    }
    return found;
  }, [q, mode, notes, commands, hits, onOpen, onCreate, folders, onMove]);
  useEffect(() => { setAt(0); }, [q, mode]);

  const pick = (i: number) => { const it = items[i]; if (!it) return; onClose(); it.run(); };
  const placeholder = mode === 'palette' ? 'Type a command' : mode === 'move' ? 'Move to which folder?' : mode === 'search' ? (scope ? `Search inside ${scope.split('/').pop()}` : 'Search inside every note') : 'Find or create a note';

  return (
    <div className="palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-label={placeholder}>
        <label className="palette-input">
          <IconSearch width={16} height={16} />
          <input ref={input} value={q} placeholder={placeholder} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') { e.preventDefault(); setAt((a) => Math.min(items.length - 1, a + 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setAt((a) => Math.max(0, a - 1)); }
              if (e.key === 'Enter') { e.preventDefault(); pick(at); }
            }} />
        </label>
        <div className="palette-list" role="listbox">
          {items.map((it, i) => (
            <button key={it.id} role="option" aria-selected={i === at} className={i === at ? 'on' : ''} onMouseEnter={() => setAt(i)} onClick={() => pick(i)}>
              <strong>{it.label}</strong>{it.hint && <span>{it.hint}</span>}
            </button>
          ))}
          {!items.length && <p className="np-empty">{mode === 'search' && q.trim().length < 2 ? 'Type at least 2 letters' : 'No matches'}</p>}
        </div>
      </div>
    </div>
  );
}
