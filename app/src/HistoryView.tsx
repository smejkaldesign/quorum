import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Brain, CalendarEvent, ChatRow, MeetingRow, NoteDoc } from './quorum';
import { NoteMenu, NoteReader, VisibilityPill } from './MeetingNote';
import { pickQuote, quoteLink } from './quotes';
import { Composer } from './Composer';
import quorumMark from '../assets/quorum-mark.png';
import { IconCalendar, IconChat, IconMic, IconExternal, IconMore, IconNotes, IconPerson, IconSearch, IconNewNote, IconListCheck, IconTarget } from './icons';

type Filter = 'all' | 'meetings' | 'notes' | 'chats';
type Row = { key: string; kind: 'meeting' | 'note' | 'chat'; title: string; sub: string; date: Date | null; avatar: string; open: () => void; meeting?: MeetingRow; children?: Row[] };

const RECIPES = [
  { label: 'Write weekly recap', icon: IconNewNote },
  { label: 'List recent todos', icon: IconListCheck },
  { label: 'Current action items', icon: IconTarget },
];
const AVATAR_COLORS = ['#8a5a3c', '#3c6e8a', '#5a3c8a', '#3c8a5e', '#8a3c55', '#6e6a3c', '#3c4f8a'];

// Granola's people line: one person by full name, two or three by first names, more as "A, B & N others"
function peopleLine(people: string[], count: number) {
  if (!people.length) return count > 1 ? `${count} people` : 'Just you';
  if (people.length === 1) return people[0];
  const first = people.map((p) => p.split(' ')[0]);
  if (first.length <= 3) return `${first.slice(0, -1).join(', ')} & ${first[first.length - 1]}`;
  return `${first.slice(0, 2).join(', ')} & ${first.length - 2} others`;
}

function dayLabel(d: Date | null) {
  if (!d) return 'Undated';
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  const t = new Date(); t.setDate(today.getDate() + 1);
  if (d.toDateString() === t.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

function colorFor(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function HistoryView({ brain, focusAsk, onAsk, onOpenChat }: { brain: Brain | null; focusAsk: number; onAsk: (q: string, files?: string[]) => void; onOpenChat: (id: string) => void }) {
  const askRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (focusAsk) askRef.current?.focus(); }, [focusAsk]);
  const [data, setData] = useState<{ meetings: MeetingRow[]; chats: ChatRow[] }>({ meetings: [], chats: [] });
  const [filter, setFilter] = useState<Filter>('all');
  // upcoming events from the connected calendar; once a meeting happens its note lands under Today instead
  const [upNext, setUpNext] = useState<CalendarEvent[]>([]);
  // events without a call on a connected platform are kept out of the list unless asked for; hidden counts them
  const [calView, setCalView] = useState<{ connected: boolean; showAll: boolean; hidden: number }>({ connected: false, showAll: false, hidden: 0 });
  const [eventMenu, setEventMenu] = useState<string | null>(null);
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  useEffect(() => { window.quorum.sourceIcons().then(setIcons); }, []);
  const calRetry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // the helper can still be starting on launch, so a miss retries in 10s instead of waiting for the 5 minute refresh
  const loadCal = useCallback(() => window.quorum.calendar().then((c) => {
    setUpNext(c.connected ? c.events.filter((e) => new Date(e.end) > new Date()) : []);
    setCalView({ connected: c.connected, showAll: c.showAll, hidden: c.hidden });
    clearTimeout(calRetry.current);
    if (c.status === 'unavailable') calRetry.current = setTimeout(loadCal, 10000);
  }), []);
  useEffect(() => {
    loadCal();
    const t = setInterval(loadCal, 5 * 60000);
    const off = window.quorum.onSettings(loadCal);
    return () => { clearInterval(t); clearTimeout(calRetry.current); off(); };
  }, [loadCal]);
  useEffect(() => {
    if (!eventMenu) return;
    const close = () => setEventMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [eventMenu]);
  const [picked, setPicked] = useState<string[]>([]);
  const [range, setRange] = useState<DateRange | null>(null);
  const [keyword, setKeyword] = useState('');
  // a keyword matches titles and people, plus anything inside the note itself (from the live vault index)
  const [bodyHits, setBodyHits] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!keyword) { setBodyHits(null); return; }
    let live = true;
    window.quorum.vaultSearch(keyword, 1000).then((h) => { if (live) setBodyHits(new Set(h.map((x) => x.rel))); });
    return () => { live = false; };
  }, [keyword]);
  const [note, setNote] = useState<NoteDoc | null>(null);
  const [draft, setDraft] = useState('');
  const [quote] = useState(pickQuote);
  // the quote stays on one line: in a window narrower than the default, the heading eases down to fit
  const heroTitle = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const h = heroTitle.current;
    if (!h) return;
    const fit = () => {
      h.style.fontSize = '';
      const room = h.clientWidth, need = h.scrollWidth;
      if (need > room) h.style.fontSize = `${Math.max(36, Math.floor(60 * room / need))}px`;
    };
    fit();
    // watch the section, not the heading: resizing the heading inside its own observer loops
    const ro = new ResizeObserver(() => requestAnimationFrame(fit));
    if (h.parentElement) ro.observe(h.parentElement);
    return () => ro.disconnect();
  }, [quote]);

  useEffect(() => { window.quorum.history().then(setData); }, [brain]);

  const people = useMemo(() => {
    const m = new Map<string, { n: number; last: string | null }>();
    for (const mt of data.meetings) for (const p of mt.people) {
      const cur = m.get(p) ?? { n: 0, last: null };
      m.set(p, { n: cur.n + 1, last: cur.last && mt.date && cur.last > mt.date ? cur.last : mt.date ?? cur.last });
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [data]);

  const rows: Row[] = useMemo(() => {
    const inRange = (d: string | null) => !range || (!!d && new Date(d) >= range.from && new Date(d) < range.to);
    const kw = keyword.toLowerCase();
    const turns = (c: ChatRow) => `Chat · ${c.turns} ${c.turns === 1 ? 'question' : 'questions'}`;
    const chatRow = (c: ChatRow, nested = false): Row => ({
      key: c.id, kind: 'chat', title: c.title, sub: !nested && c.meetingTitle ? `About ${c.meetingTitle} · ${turns(c)}` : turns(c),
      date: c.date ? new Date(c.date) : null, avatar: 'chat', open: () => onOpenChat(c.id),
    });
    const chatFits = (c: ChatRow) => inRange(c.date) && (!kw || c.title.toLowerCase().includes(kw));
    if (filter === 'chats') return picked.length ? [] : data.chats.filter(chatFits).map((c) => chatRow(c));

    // a chat about a meeting always sits under that meeting, never on its own
    const byMeeting = new Map<string, ChatRow[]>();
    for (const c of data.chats) if (c.meetingFile) (byMeeting.get(c.meetingFile) ?? byMeeting.set(c.meetingFile, []).get(c.meetingFile)!).push(c);
    const meetings: Row[] = data.meetings.filter((m) => (filter !== 'meetings' || m.kind !== 'note') && (filter !== 'notes' || m.kind === 'note')
      && (!picked.length || picked.some((p) => m.people.includes(p))) && inRange(m.date)
      && (!kw || `${m.title} ${m.people.join(' ')}`.toLowerCase().includes(kw) || !!bodyHits?.has(m.rel))).map((m) => ({
      key: m.id, kind: m.kind, title: m.title, sub: m.kind === 'note' ? 'Note' : peopleLine(m.people, m.count),
      date: m.date ? new Date(m.date) : null, avatar: m.kind === 'note' ? 'note' : (m.people[0] ?? m.title).trim()[0]?.toUpperCase() ?? '?',
      open: () => window.quorum.readNote(m.file).then(setNote), meeting: m,
      children: (byMeeting.get(m.file) ?? []).map((c) => chatRow(c, true)),
    }));
    if (filter === 'meetings' || filter === 'notes' || picked.length) return meetings;
    const known = new Set(data.meetings.map((m) => m.file));
    const loose = data.chats.filter((c) => (!c.meetingFile || !known.has(c.meetingFile)) && chatFits(c)).map((c) => chatRow(c));
    return [...meetings, ...loose].sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
  }, [data, filter, picked, range, keyword, bodyHits, onOpenChat]);

  const groups = useMemo(() => {
    const g: { label: string; rows: Row[] }[] = [];
    for (const r of rows.slice(0, 300)) {
      const label = dayLabel(r.date);
      if (g[g.length - 1]?.label !== label) g.push({ label, rows: [] });
      g[g.length - 1].rows.push(r);
    }
    return g;
  }, [rows]);

  const refresh = () => window.quorum.history().then(setData);
  const filtered = filter === 'chats' || picked.length > 0 || !!range || !!keyword;
  if (note) return <NoteReader note={note} dayLabel={dayLabel} peopleLine={peopleLine} onBack={() => { setNote(null); refresh(); }} />;

  const ask = (q: string, files: string[] = []) => { if (q.trim()) { setDraft(''); onAsk(q.trim(), files); } };

  return (
    <div className="history">
      <section className="hist-hero">
        <h1 ref={heroTitle}>
          {quote.text}
        </h1>
        <button className="hist-quote" onClick={() => window.quorum.openExternal(quoteLink(quote))} data-tip={quote.url.includes('wikiquote') ? 'See it on Wikiquote' : 'See it on Wikipedia'}
          aria-label={`${quote.who}, ${quote.source}. Opens the source`}>
          <span className="hq-who">{quote.who}</span><span className="hq-bar">|</span><span className="hq-src">{quote.source}</span><IconExternal width={13} height={13} />
        </button>
      </section>

      <Composer className="hist-ask" value={draft} onChange={setDraft} onSubmit={(q, f) => ask(q, f)} inputRef={askRef} disabled={!brain} placeholder="Ask anything" />
      <div className="recipes">
        {RECIPES.map((r) => <button key={r.label} className="recipe" onClick={() => ask(r.label)}><r.icon width={15} height={15} />{r.label}</button>)}
      </div>

      <hr className="hist-rule" />

      <div className="hist-filters">
        <button className={`filter ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>All</button>
        <button className={`filter ${filter === 'meetings' ? 'on' : ''}`} onClick={() => setFilter('meetings')}><IconNotes width={17} height={17} />Meetings</button>
        <button className={`filter ${filter === 'notes' ? 'on' : ''}`} onClick={() => setFilter('notes')}><IconMic width={17} height={17} />Notes</button>
        <button className={`filter ${filter === 'chats' ? 'on' : ''}`} onClick={() => setFilter('chats')}><IconChat width={17} height={17} />Chats</button>
        <span className="filter-spacer" />
        <PeopleFilter people={people} picked={picked} onChange={(p) => { setPicked(p); if (p.length && filter === 'chats') setFilter('all'); }} />
        <DateFilter value={range} onChange={setRange} />
        <KeywordFilter value={keyword} onChange={setKeyword} />
      </div>

      {!filtered && calView.connected && (upNext.length > 0 || calView.hidden > 0) && (
        <div className="hist-group up-next">
          <div className="up-head">
            <h4>Up next</h4>
            {(calView.hidden > 0 || calView.showAll) && (
              <label className="up-toggle"><input type="checkbox" checked={calView.showAll} onChange={(ev) => window.quorum.calendarSet({ showAll: ev.target.checked }).then(loadCal)} />Show no meeting{!calView.showAll && calView.hidden > 0 ? ` (${calView.hidden})` : ''}</label>
            )}
          </div>
          {upNext.length === 0 && <p className="up-empty">No calls on a connected platform in the next few days.</p>}
          {upNext.map((e) => {
            const at = new Date(e.start), end = new Date(e.end);
            const t = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?(AM|PM)/i, '');
            const platform = e.platform ? { zoom: 'Zoom', meet: 'Google Meet', teams: 'Microsoft Teams' }[e.platform] : null;
            const open = eventMenu === e.id;
            return (
              <div key={e.id} className="hist-item">
                <div className={`hist-row up-row ${open ? 'menu-open' : ''}`} onClick={() => e.item && window.quorum.calendarOpen(e)}>
                  <span className="avatar-sq cal"><IconCalendar width={20} height={20} /></span>
                  <span className="hist-text"><strong>{e.title}</strong><span>{dayLabel(at)} · {t(at)} – {t(end)} {end.getHours() < 12 ? 'AM' : 'PM'}{platform ? ` · ${platform}` : ''}</span></span>
                  {!e.platform && <span className="up-badge">No meeting</span>}
                  <span className="hist-time">{t(at)}<small>{at.getHours() < 12 ? 'AM' : 'PM'}</small></span>
                  <span className="hist-hover menu-wrap" onMouseDown={(ev) => ev.stopPropagation()}>
                    <button className="icon-btn up-more" aria-label="More" aria-expanded={open} onClick={(ev) => { ev.stopPropagation(); setEventMenu(open ? null : e.id); }}><IconMore /></button>
                    {open && (
                      <div className="menu up-menu" onClick={(ev) => ev.stopPropagation()}>
                        {e.item && <button onClick={() => { setEventMenu(null); window.quorum.calendarOpen(e); }}>View in Calendar</button>}
                        {e.join && <button onClick={() => { setEventMenu(null); window.quorum.openExternal(e.join!); }}>Open call link</button>}
                        <button onClick={() => { setEventMenu(null); window.quorum.calendarSet({ hide: e.id }).then(loadCal); }}>Remove from list</button>
                      </div>
                    )}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {groups.length === 0 ? (
        <p className="hist-empty">{picked.length || range || keyword ? 'Nothing matches these filters.' : filter === 'chats' ? 'No chats yet. Ask anything above to start one.' : 'No meetings or chats yet. Notes saved from Quorum and Granola show up here.'}</p>
      ) : groups.map((g) => (
        <div key={g.label} className="hist-group">
          <h4>{g.label}</h4>
          {g.rows.map((r) => (
            <div key={r.key} className="hist-item">
            <div className="hist-row" role="button" tabIndex={0} onClick={r.open} onKeyDown={(e) => { if (e.key === 'Enter') r.open(); }}>
              {r.avatar === 'chat'
                ? <span className="avatar-sq chat"><img src={quorumMark} alt="" /></span>
                : r.avatar === 'note' ? <span className="avatar-sq note"><IconMic width={20} height={20} /></span>
                : <span className="avatar-sq" style={{ background: colorFor(r.sub + r.title) }}>{r.avatar}
                    {r.meeting && r.meeting.source !== 'quorum' && (
                      <span className="src-badge" data-tip={`From ${r.meeting.source[0].toUpperCase()}${r.meeting.source.slice(1)}`}>
                        {icons[r.meeting.source] ? <img src={icons[r.meeting.source]!} alt={r.meeting.source} /> : r.meeting.source[0].toUpperCase()}
                      </span>
                    )}
                  </span>}
              <span className="hist-text"><strong>{r.title}</strong><span>{r.sub}</span></span>
              <span className="hist-time">{r.date ? <>{r.date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?(AM|PM)/i, '')}<small>{r.date.getHours() < 12 ? 'AM' : 'PM'}</small></> : ''}</span>
              {r.meeting && (
                <span className="hist-hover">
                  <VisibilityPill compact value={r.meeting.visibility} onChange={async (v) => { await window.quorum.noteVisibility(r.meeting!.file, v); refresh(); }} />
                  <NoteMenu compact note={{ file: r.meeting.file, rel: r.meeting.rel, app: r.meeting.app, link: r.meeting.link }} onDeleted={refresh} />
                </span>
              )}
            </div>
            {r.children?.map((c) => (
              <div key={c.key} className="hist-row hist-child" role="button" tabIndex={0} onClick={c.open} onKeyDown={(e) => { if (e.key === 'Enter') c.open(); }}>
                <span className="hist-branch" aria-hidden="true" />
                <span className="avatar-sq chat tiny"><img src={quorumMark} alt="" /></span>
                <span className="hist-text"><strong>{c.title}</strong><span>{c.sub}</span></span>
              </div>
            ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// People is a filter, not a page: the pill opens a typeahead; picked people show as removable chips above the search
function PeopleFilter({ people, picked, onChange }: { people: [string, { n: number; last: string | null }][]; picked: string[]; onChange: (p: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const close = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = people.filter(([name]) => !picked.includes(name) && words.every((w) => name.toLowerCase().includes(w))).slice(0, 60);
  useEffect(() => { setAt(0); }, [q]);
  const toggle = (name: string) => { onChange(picked.includes(name) ? picked.filter((p) => p !== name) : [...picked, name]); setQ(''); input.current?.focus(); };
  const label = picked.length === 0 ? 'People' : picked.length === 1 ? picked[0] : `${picked.length} people`;

  return (
    <div className="menu-wrap" ref={wrap}>
      <button className={`filter ${picked.length ? 'on' : 'icon-only'}`} aria-haspopup="dialog" aria-expanded={open} aria-label={picked.length ? `People: ${label}` : 'Filter by people'}
        data-tip={picked.length ? undefined : 'People'} onClick={() => setOpen((o) => !o)}>
        <IconPerson width={17} height={17} />{picked.length > 0 && label}
        {picked.length > 0 && <span className="filter-x" role="button" aria-label="Clear people" onClick={(e) => { e.stopPropagation(); onChange([]); }}>×</span>}
      </button>
      {open && (
        <div className="people-pop" role="dialog" aria-label="Filter by people">
          {picked.length > 0 && (
            <div className="pp-chips">
              {picked.map((p) => <button key={p} className="pp-chip" onClick={() => toggle(p)} aria-label={`Remove ${p}`}>{p}<span>×</span></button>)}
            </div>
          )}
          <input ref={input} value={q} placeholder="Search people" onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              if (e.key === 'ArrowDown') { e.preventDefault(); setAt((a) => Math.min(list.length - 1, a + 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setAt((a) => Math.max(0, a - 1)); }
              if (e.key === 'Enter' && list[at]) { e.preventDefault(); toggle(list[at][0]); }
              if (e.key === 'Backspace' && !q && picked.length) onChange(picked.slice(0, -1));
            }} />
          <div className="pp-list" role="listbox">
            {list.map(([name, info], i) => (
              <button key={name} role="option" aria-selected={i === at} className={i === at ? 'on' : ''} onMouseEnter={() => setAt(i)} onClick={() => toggle(name)}>
                <span className="avatar-sq tiny" style={{ background: colorFor(name) }}>{name[0]?.toUpperCase()}</span>
                <strong>{name}</strong><em>{info.n} {info.n === 1 ? 'meeting' : 'meetings'}</em>
              </button>
            ))}
            {!list.length && <p className="np-empty">No one matches.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

type DateRange = { from: Date; to: Date; label: string };

// close a filter popover on an outside click, focus its input on open
function usePopover() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLInputElement>('.fp-input')?.focus();
    const close = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return { open, setOpen, wrap };
}

// icon only until something is applied, then the applied value shows with an ×
function FilterPill({ icon, name, label, active, open, onToggle, onClear }: { icon: ReactNode; name: string; label: string; active: boolean; open: boolean; onToggle: () => void; onClear: () => void }) {
  return (
    <button className={`filter ${active ? 'on' : 'icon-only'}`} aria-haspopup="dialog" aria-expanded={open} aria-label={active ? `${name}: ${label}` : `Filter by ${name.toLowerCase()}`}
      data-tip={active ? undefined : name} onClick={onToggle}>
      {icon}{active && label}
      {active && <span className="filter-x" role="button" aria-label={`Clear ${label}`} onClick={(e) => { e.stopPropagation(); onClear(); }}>×</span>}
    </button>
  );
}

const day0 = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromYmd = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

function presets(): DateRange[] {
  const t = day0(new Date());
  const month = new Date(t.getFullYear(), t.getMonth(), 1);
  return [
    { label: 'Today', from: t, to: addDays(t, 1) },
    { label: 'Yesterday', from: addDays(t, -1), to: t },
    { label: 'Last 7 days', from: addDays(t, -6), to: addDays(t, 1) },
    { label: 'Last 30 days', from: addDays(t, -29), to: addDays(t, 1) },
    { label: 'This month', from: month, to: addDays(t, 1) },
    { label: 'Last month', from: new Date(t.getFullYear(), t.getMonth() - 1, 1), to: month },
  ];
}

// one date range at a time: presets or a custom from/to; the chosen range sits in the picker as a removable chip
function DateFilter({ value, onChange }: { value: DateRange | null; onChange: (r: DateRange | null) => void }) {
  const { open, setOpen, wrap } = usePopover();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const pick = (r: DateRange | null) => { onChange(r); setOpen(false); };
  const custom = () => {
    if (!from) return;
    const f = fromYmd(from);
    const t = to ? fromYmd(to) : f;
    const [a, b] = f <= t ? [f, t] : [t, f];
    const fmt = (d: Date) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    pick({ from: a, to: addDays(b, 1), label: ymd(a) === ymd(b) ? fmt(a) : `${fmt(a)} – ${fmt(b)}` });
  };
  return (
    <div className="menu-wrap" ref={wrap}>
      <FilterPill icon={<IconCalendar width={17} height={17} />} name="Date" label={value?.label ?? ''} active={!!value} open={open} onToggle={() => setOpen((o) => !o)} onClear={() => onChange(null)} />
      {open && (
        <div className="people-pop date-pop" role="dialog" aria-label="Filter by date">
          {value && <div className="pp-chips"><button className="pp-chip" onClick={() => onChange(null)} aria-label={`Remove ${value.label}`}>{value.label}<span>×</span></button></div>}
          <div className="dp-presets">
            {presets().map((p) => <button key={p.label} className={value?.label === p.label ? 'on' : ''} onClick={() => pick(p)}>{p.label}</button>)}
          </div>
          <div className="dp-custom">
            <label>From<input className="fp-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <button className="pill primary small-pill" disabled={!from} onClick={custom}>Apply</button>
          </div>
        </div>
      )}
    </div>
  );
}

// one keyword; it searches titles, people and note text, and shows in the search box as a removable chip
function KeywordFilter({ value, onChange }: { value: string; onChange: (k: string) => void }) {
  const { open, setOpen, wrap } = usePopover();
  const [q, setQ] = useState(value);
  useEffect(() => { setQ(value); }, [value]);
  // the list follows the field as you type; a short pause keeps the vault search from running on every keystroke
  useEffect(() => {
    const k = q.trim();
    if (k === value) return;
    const t = setTimeout(() => onChange(k), 150);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="menu-wrap" ref={wrap}>
      <FilterPill icon={<IconSearch width={17} height={17} />} name="Keyword" label={value ? `“${value}”` : ''} active={!!value} open={open} onToggle={() => setOpen((o) => !o)} onClear={() => onChange('')} />
      {open && (
        <div className="people-pop kw-pop" role="dialog" aria-label="Filter by keyword">
          <div className="kw-box">
            <input className="fp-input" autoFocus value={q} placeholder="Search titles, people and notes" onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setOpen(false); if (e.key === 'Escape') { setQ(''); onChange(''); setOpen(false); } }} />
            {q && <button className="kw-clear" aria-label="Clear" onClick={() => { setQ(''); onChange(''); }}>×</button>}
          </div>
        </div>
      )}
    </div>
  );
}

