import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Backlink, OutLink, SearchHit } from './quorum';
import { IconChevron, IconSearch } from './icons';

// Right-hand panel beside an open note: what links here, what it links to, and its headings
export function NotePanel({ rel, body, onOpen, onResolve }: {
  rel: string; body: string; onOpen: (rel: string) => void; onResolve: (target: string) => void;
}) {
  const [back, setBack] = useState<Backlink[]>([]);
  const [out, setOut] = useState<OutLink[]>([]);
  useEffect(() => {
    let live = true;
    Promise.all([window.quorum.vaultBacklinks(rel), window.quorum.vaultOutgoing(rel)]).then(([b, o]) => { if (live) { setBack(b); setOut(o); } });
    return () => { live = false; };
  }, [rel, body]);
  const outline = useMemo(() => body.split('\n').map((l) => l.match(/^(#{1,4})\s+(.+)$/)).filter(Boolean).map((m) => ({ level: m![1].length, text: m![2] })), [body]);
  const uniqueOut = useMemo(() => [...new Map(out.map((o) => [o.rel ?? `?${o.target}`, o])).values()], [out]);

  return (
    <aside className="note-panel" aria-label="Links and outline">
      <Section title="Backlinks" count={back.length}>
        {back.length ? back.map((b, i) => (
          <button key={`${b.rel}-${i}`} className="np-item" onClick={() => onOpen(b.rel)}>
            <strong>{b.title}</strong>
            {b.context && <span>{b.context.slice(0, 140)}</span>}
          </button>
        )) : <p className="np-empty">No notes link here yet.</p>}
      </Section>
      <Section title="Outgoing links" count={uniqueOut.length}>
        {uniqueOut.length ? uniqueOut.map((o) => (
          <button key={o.rel ?? o.target} className={`np-item ${o.rel ? '' : 'unresolved'}`} onClick={() => (o.rel ? onOpen(o.rel) : onResolve(o.target))}
            data-tip={o.rel ? undefined : 'No note with this name yet'} data-tip-pos="left">
            <strong>{o.title}</strong>
          </button>
        )) : <p className="np-empty">This note doesn't link anywhere.</p>}
      </Section>
      <Section title="Outline" count={outline.length}>
        {outline.length ? outline.map((h, i) => <p key={i} className="np-outline" style={{ paddingLeft: (h.level - 1) * 12 }}>{h.text}</p>) : <p className="np-empty">No headings.</p>}
      </Section>
    </aside>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(true);
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
