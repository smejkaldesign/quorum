import { BackButton } from './BackButton';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CalendarEvent, MeetingBrief, MeetingPrep } from './quorum';
import { useFlag } from './flags';
import { CALENDAR_APP, PLATFORM_APP } from './AppChip';
import { Markdown } from './Markdown';
import { dayLabel } from './upNextList';
import { IconCalendar, IconPeople } from './icons';
import { AgentRun } from './AgentActivity';
import { AppIcon } from './NoteMeta';
import { TypedTitle, toPageTop, useStuck, useToolbarDock, useAtEnd } from './StickyBar';
import { JoinButton } from './UpNext';
import { NoteEditor } from './editor/NoteEditor';
import { IconLogs, IconNotes, IconRecord, IconSound } from './icons';
import { Composer } from './Composer';
import { Avatar } from './Speaker';
import { splitChoices } from './MeetingNote';
import { ChatExit, ChatStrip, useChats, useComposerFocus } from './ChatStack';
import markProd from '../assets/quorum-mark.png';

// one click each, above the chat input before the first question
const PREP_ASKS = ['What is still open from last time?', 'What should I ask in this meeting?'];

// questions about the meeting before it happens, answered from its prep notes, past notes and the rest of the Agent OS
function MeetingChat({ event }: { event: CalendarEvent }) {
  const cs = useChats<{ q: string; a: string; pending?: boolean }>();
  // the composer's shadow is full only while content scrolls beneath it
  const dockRef = useRef<HTMLDivElement>(null);
  const dockEnd = useAtEnd(dockRef);
  const turns = cs.active?.turns ?? [];
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState('');
  const [step, setStep] = useState('');
  const [me, setMe] = useState<{ name: string; photo: string | null }>({ name: 'You', photo: null });
  useEffect(() => { window.quorum.user().then((u) => { if (u) setMe({ name: u.name || 'You', photo: u.photo ?? null }); }).catch(() => {}); }, []);
  useEffect(() => window.quorum.onNoteDelta(({ text }) => setLive(text)), []);
  useEffect(() => window.quorum.onAgentStep(({ text }) => setStep(text)), []);
  // its saved chat comes back with the page; opened from the row's chats link, the page scrolls down to it
  useEffect(() => {
    window.quorum.eventChats(event.id).then((list) => {
      cs.setChats(list);
      if (event.openChat && list.length) requestAnimationFrame(() => document.querySelector('.meeting-page .note-thread')?.scrollIntoView({ block: 'start' }));
    }).catch(() => {});
  }, [event.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const busy = cs.chats.some((c) => c.turns.some((t) => t.pending));
  // asking keeps the page at the bottom of the chat while the answer comes in
  useLayoutEffect(() => {
    if (!turns.length || !turns[turns.length - 1].pending) return;
    const box = document.querySelector<HTMLElement>('.meeting-page')?.closest<HTMLElement>('.body');
    box?.scrollTo({ top: box.scrollHeight });
  }, [turns, live, step]);
  async function ask(said?: string) {
    const q = (said ?? draft).trim();
    if (!q || busy) return;
    setDraft(''); setLive(''); setStep('');
    const to = cs.target();
    cs.update(to.id, (t) => [...t, { q, a: '', pending: true }]);
    let a: string;
    let saved: string | undefined;
    try { const r = await window.quorum.meetingAsk(event, q, to.history, to.send); a = r.text; saved = r.chatId; } catch (err) { a = `Couldn't answer: ${String(err).replace(/^.*Error:\s*/, '')}`; }
    cs.update(to.id, (t) => t.map((x, i) => (i === t.length - 1 ? { q: x.q, a } : x)));
    cs.settle(to.id, saved);
  }
  const inChat = useComposerFocus();
  return (
    <>
      {cs.active && (
        <section className={`note-thread chat-open${cs.closing ? ' closing' : ''}`} aria-label="Questions about this meeting">
          <ChatExit onExit={cs.exit} />
          {turns.map((t, i) => {
            const { text, choices } = splitChoices(t.pending ? live : t.a);
            return (
              <div key={i} className="nt-turn">
                <div className="nt-who"><Avatar name={me.name} photo={me.photo} size={22} /><strong>{me.name}</strong></div>
                <p className="nt-q">{t.q}</p>
                <div className="nt-who quorum"><img src={markProd} alt="" width={22} height={22} /><strong>Quorum</strong></div>
                {t.pending && !text ? <p className="nt-step shimmer">{step || 'Thinking…'}</p> : <div className="nt-a"><Markdown text={text} /></div>}
                {!t.pending && i === turns.length - 1 && choices.length > 0 && (
                  <div className="nt-choices">{choices.map((c) => <button key={c} className="pill small-pill" disabled={busy} onClick={() => ask(c)}>{c}</button>)}</div>
                )}
              </div>
            );
          })}
        </section>
      )}
      <div ref={dockRef} className={`note-dock${dockEnd ? ' at-end' : ''}`}>
        {!cs.active && !cs.chats.length && inChat && (
          <div className="skill-pills" role="group" aria-label="Quick asks">
            {PREP_ASKS.map((q) => <button key={q} className="skill-pill" disabled={busy} onClick={() => ask(q)}>{q}</button>)}
          </div>
        )}
{!cs.active && <ChatStrip chats={cs.chats} onOpen={cs.setOpenId} me={me} />}
        <Composer className="note-composer" value={draft} onChange={setDraft} onSubmit={() => ask()} busy={busy} onNewChat={cs.chats.length ? cs.newChat : undefined} placeholder="Ask about this meeting" />
      </div>
    </>
  );
}

const ABOUT = [['what', 'What it is'], ['who', 'Who attends'], ['how', 'How it runs']] as const;

// a section's loading placeholder: grey lines that shimmer
function Skeleton({ lines }: { lines: number }) {
  return <div className="mp-skel" aria-label="Loading">{Array.from({ length: lines }, (_, i) => <span key={i} style={{ width: `${i === lines - 1 ? 60 : 100}%` }} />)}</div>;
}

// Text that types in: reveal(text) returns as much of each text as the shared clock has reached, so every section
// starts and finishes together whatever its length. Reduced motion shows it all at once.
function useReveal(total: number, key: unknown) {
  const [p, setP] = useState(1);
  useEffect(() => {
    if (!total || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setP(1); return; }
    setP(0);
    const start = performance.now(), ms = 550;
    let raf = 0;
    const tick = (t: number) => { const x = Math.min(1, (t - start) / ms); setP(x); if (x < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [total, key]);
  return (text: string) => (p >= 1 ? text : text.slice(0, Math.ceil(text.length * p)));
}

const clock = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// what the prep section says when there is no note to show
const PREP_EMPTY: Partial<Record<MeetingPrep['status'], string>> = {
  'opted-out': 'No prep for this meeting. Someone invited is on your never-listen list.',
  skipped: 'Quorum prepares notes ahead only for meetings with more people, or with someone new. You can still prepare one for this meeting.',
  'no-model': 'Choose a model in Settings and Quorum writes a prep note from your vault.',
  'no-vault': 'Connect your vault and Quorum writes a prep note from it.',
  failed: 'Quorum could not write a prep note this time. Try again.',
  missing: 'Quorum could not find this event in your calendar.',
  dismissed: 'You deleted the prep note for this meeting. Quorum writes a new one only when you ask.',
};

// The prep note from the vault (main.js meeting-prep): who is invited and what the vault says about them, past
// meetings, open items and talking points, each linked to its source note. Join stays the primary action and View in
// Calendar the secondary one; the note itself opens like any other note in the vault
function VaultPrep({ event: e, onOpenNote }: { event: CalendarEvent; onOpenNote: (file: string) => void }) {
  const [prep, setPrep] = useState<MeetingPrep | null>(null);
  const [writing, setWriting] = useState(false);
  const write = (force: boolean) => {
    setWriting(true);
    return window.quorum.meetingPrep(e.id, force ? { force: true } : { generate: true }).then(setPrep).catch(() => setPrep({ status: 'failed' })).finally(() => setWriting(false));
  };
  useEffect(() => {
    let live = true;
    window.quorum.meetingPrep(e.id).then((r) => {
      if (!live) return;
      setPrep(r);
      // a note not written yet, or one whose invite changed and that you have not edited, is written now
      if (r.status === 'stale' || (r.status === 'changed' && !r.edited)) { setWriting(true); window.quorum.meetingPrep(e.id, { generate: true }).then((g) => { if (live) setPrep(g); }).catch(() => { if (live) setPrep({ status: 'failed' }); }).finally(() => { if (live) setWriting(false); }); }
    }).catch(() => { if (live) setPrep({ status: 'failed' }); });
    return () => { live = false; };
  }, [e.id]);
  const platform = e.platform ? PLATFORM_APP[e.platform] : null;
  const has = prep?.status === 'ready' || prep?.status === 'changed';
  // the heading and date line are the page's own; the saved note keeps them for the vault
  const md = prep?.markdown ?? '';
  const text = md.indexOf('## ') > 0 ? md.slice(md.indexOf('## ')) : md;
  const onWiki = (target: string) => { const file = prep?.links?.[target]; if (file) onOpenNote(file); };
  return (
    <section className="mp-section mp-prep" aria-busy={!prep || writing}>
      <div className="mp-head">
        <h2>Meeting prep</h2>
        <span className="mp-prep-actions">
          {platform && e.join && <button className="act-pill primary" onClick={() => window.quorum.openExternal(e.join!)}>Join on {platform.short}</button>}
          {(e.item || e.link) && <button className="act-pill" onClick={() => window.quorum.calendarOpen(e)}>View in Calendar</button>}
        </span>
      </div>
      {!prep || writing ? <Skeleton lines={6} />
        : has ? <>
          {prep.edited ? <p className="muted" role="status">You edited this note. Prepare again writes a new note and keeps yours.</p>
            : prep.status === 'changed' && <p className="muted" role="status">The invite changed since this note was written.</p>}
          <Markdown text={text} onWiki={onWiki} />
          <p className="mp-prep-foot">
            {prep.file && <button className="up-all" onClick={() => onOpenNote(prep.file!)}>Open note</button>}
            <button className="up-all" disabled={writing} onClick={() => write(true)}>Prepare again</button>
          </p>
        </>
        : <>
          <p className="mp-empty" role="status">{PREP_EMPTY[prep.status] ?? PREP_EMPTY.failed}</p>
          {(prep.status === 'skipped' || prep.status === 'failed' || prep.status === 'dismissed') && <p className="mp-prep-foot"><button className="up-all" disabled={writing} onClick={() => write(prep.status !== 'failed')}>Prepare a note</button></p>}
        </>}
    </section>
  );
}

// The page an upcoming meeting opens to from Home or Up next: when it is, who is invited, its calendar and meeting
// app, and for a recurring meeting, prep notes and a short description written from its past notes (main.js
// meeting-brief). Fewer past meetings than the threshold shows what will appear once there are, and with the
// meeting-prep flag on, Generate anyway writes them now from the invite and the vault (meetingOneOff.js).
export function MeetingPage({ event: e, onBack, onOpenNote }: { event: CalendarEvent; onBack: () => void; onOpenNote: (file: string) => void }) {
  const [prepEnabled, setPrepEnabled] = useState(false);
  useEffect(() => { window.quorum.getSettings().then((s) => setPrepEnabled(s?.meetingPrep?.enabled === true)).catch(() => {}); }, []);
  const [data, setData] = useState<MeetingBrief | null>(null);
  const [writing, setWriting] = useState(false);
  const bar = useStuck();
  useToolbarDock(bar.sentinel, bar.stuck);
  // a tab picked while the bar is pinned opens at the top of the page
  const pick = (t: typeof tab) => { setTab(t); if (bar.stuck) toPageTop(bar.sentinel); };
  const top = useRef<HTMLDivElement>(null);
  // three tabs: the prep from past meetings, your own notes ahead of time, and a transcript you can start from here
  const [tab, setTab] = useState<'prep' | 'note' | 'transcript'>('prep');
  // your notes for an upcoming meeting stay on this Mac until you save them or record; they come back when you return
  const draftKey = `event-note:${e.id}`;
  const [mine, setMine] = useState(() => { try { return localStorage.getItem(draftKey) ?? ''; } catch { return ''; } });
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [savingMine, setSavingMine] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [run, setRun] = useState<{ file: string; since: number } | null>(null);
  const [relatedAll, setRelatedAll] = useState(false);
  // the vault prep note takes the place of the series' prep bullets when it is on
  const vaultPrep = useFlag('meeting-prep') && prepEnabled;
  const keep = (v: string) => { setMine(v); try { if (v.trim()) localStorage.setItem(draftKey, v); else localStorage.removeItem(draftKey); } catch { /* ignore */ } };
  async function saveMine() {
    if (savingMine) return;
    setSavingMine(true); setSaveError('');
    try {
      const r = await window.quorum.handNoteSave({ id: `event-${Date.now()}`, file: null, title: e.title, body: mine.trim(), hash: null, fresh: true });
      if ('error' in r || 'conflict' in r) { setSaveError("Couldn't save the note. Try again."); return; }
      window.quorum.handNoteDone(r.file);
      setRun({ file: r.file, since: Date.now() });
      setSavedTo(r.rel);
      keep('');
    } finally { setSavingMine(false); }
  }
  // Record from here: the recording page opens with this meeting's title and your notes so far
  // the notes here clear only once the recording has them; with a call already running, nothing changes
  const record = () => { window.dispatchEvent(new CustomEvent('quorum:record-into', { detail: { title: e.title, notes: mine, started: () => keep('') } })); };
  useLayoutEffect(() => { top.current?.scrollIntoView({ block: 'start' }); }, [e.id]);
  useEffect(() => {
    let live = true;
    setData(null);
    window.quorum.meetingBrief({ title: e.title, organizer: e.organizer, id: e.id }).then((r) => {
      if (!live) return;
      setData(r);
      if (r.status !== 'stale') return;
      setWriting(true);
      window.quorum.meetingBrief({ title: e.title, organizer: e.organizer, id: e.id, generate: true }).then((g) => { if (live) setData(g); }).finally(() => { if (live) setWriting(false); });
    }).catch(() => { if (live) setData({ past: [], brief: null, status: 'failed' }); });
    return () => { live = false; };
  }, [e.id, e.title]);

  // Generate anyway, and Regenerate once there is a one-off brief: written from the invite and the vault, kept on the meeting
  const generate = (force: boolean) => {
    setWriting(true);
    window.quorum.meetingBrief({ title: e.title, organizer: e.organizer, id: e.id, generate: true, anyway: true, force })
      .then((g) => setData((d) => ({ ...g, related: g.related ?? d?.related })))
      .catch(() => setData((d) => (d ? { ...d, status: 'failed' } : d)))
      .finally(() => setWriting(false));
  };
  const at = new Date(e.start), end = new Date(e.end);
  const platform = e.platform ? PLATFORM_APP[e.platform] : null;
  const brief = data?.brief;
  const loading = !data || writing;
  const min = data?.min ?? 3;
  // a meeting with too few past meetings, where Generate anyway is offered (the meeting-prep flag is on)
  const canAnyway = !!data?.anyway && !brief && (data.status === 'few' || data.status === 'failed');
  const onWiki = (target: string) => { const file = data?.links?.[target]; if (file) onOpenNote(file); };
  const oneOffFoot = brief?.oneOff ? <p className="mp-prep-foot"><button className="up-all" disabled={writing} onClick={() => generate(true)}>Regenerate</button></p> : null;
  const anywayFoot = canAnyway ? <p className="mp-prep-foot"><button className="up-all" disabled={writing} onClick={() => generate(false)}>Generate anyway</button></p> : null;
  // once the brief arrives, every section types itself in together over about half a second
  const reveal = useReveal(brief ? [brief.prep, brief.what, brief.who, brief.how].join('').length : 0, brief);
  const emptyText = data?.status === 'few' ? `Not recurring yet. After ${min} or more meetings, Quorum starts showing a summary and prep notes for this meeting, specific to you.${data.anyway ? ' Generate anyway writes them now from the invite and your vault.' : ''}`
    : data?.status === 'no-model' ? "Choose a model in Settings and Quorum writes prep notes from this meeting's past notes."
    : data?.status === 'opted-out' ? 'No prep for this meeting. Someone invited is on your never-listen list.'
    : data?.anyway ? 'Quorum could not write prep notes this time. Try again.'
    : 'Quorum could not write prep notes this time. They are tried again the next time you open this meeting.';
  return (
    <div className="history reader meeting-page" ref={top}>
      <div ref={bar.sentinel} className="rb-sentinel" aria-hidden="true" />
      <div className={`reader-bar sticky-bar${bar.stuck ? ' stuck' : ''}`}>
        <span className="rb-left"><BackButton onClick={onBack} /><TypedTitle text={e.title} on={bar.stuck} /></span>
        <div className="reader-actions">
          {bar.stuck && <div className="view-toggle rb-tabs mp-tabs" role="group" aria-label="Show">
            <button className={tab === 'prep' ? 'on' : ''} aria-pressed={tab === 'prep'} aria-label="Prep" data-tip="Prep" onClick={() => pick('prep')}><IconLogs width={16} height={16} /></button>
            <button className={tab === 'note' ? 'on' : ''} aria-pressed={tab === 'note'} aria-label="Note" data-tip="Note" onClick={() => pick('note')}><IconNotes width={16} height={16} /></button>
            <button className={tab === 'transcript' ? 'on' : ''} aria-pressed={tab === 'transcript'} aria-label="Transcript" data-tip="Transcript" onClick={() => pick('transcript')}><IconSound width={16} height={16} /></button>
          </div>}
          {platform && e.join && <JoinButton id={platform.id} label="Join" name={platform.short} url={e.join} />}
          <button className="act-pill" onClick={record}><IconRecord width={15} height={15} /> Record</button>
          {mine.trim() && <button className="act-pill primary" disabled={savingMine} onClick={saveMine}>{savingMine ? 'Saving…' : 'Save updates'}</button>}
        </div>
      </div>
      <article className="doc">
        {run && <AgentRun key={run.since} file={run.file} since={run.since} onDetails={() => onOpenNote(run.file)} onClose={() => setRun(null)} />}
        <h1>{e.title}</h1>
        <div className="meta-row">
          <span className="meta-pill"><IconCalendar width={16} height={16} />{dayLabel(at)} · {clock(at)} – {clock(end)}</span>
          {e.calendar && <AppIcon id={CALENDAR_APP[e.calendar].id} name={CALENDAR_APP[e.calendar].name} onOpen={e.item || e.link ? () => window.quorum.calendarOpen(e) : null} />}
          {platform && <AppIcon id={platform.id} name={platform.short} onOpen={e.join ? () => window.quorum.openExternal(e.join!) : null} />}
          {(e.count ?? 0) > 0 && <span className="meta-pill" aria-label={`${e.count} ${e.count === 1 ? 'person' : 'people'}`} data-tip={`${e.count} ${e.count === 1 ? 'person' : 'people'}`}><IconPeople width={16} height={16} />{e.count}</span>}
          <div className="view-toggle mp-tabs" role="group" aria-label="Show">
            <button className={tab === 'prep' ? 'on' : ''} aria-pressed={tab === 'prep'} aria-label="Prep" data-tip="Prep" onClick={() => pick('prep')}><IconLogs width={16} height={16} /></button>
            <button className={tab === 'note' ? 'on' : ''} aria-pressed={tab === 'note'} aria-label="Note" data-tip="Note" onClick={() => pick('note')}><IconNotes width={16} height={16} /></button>
            <button className={tab === 'transcript' ? 'on' : ''} aria-pressed={tab === 'transcript'} aria-label="Transcript" data-tip="Transcript" onClick={() => pick('transcript')}><IconSound width={16} height={16} /></button>
          </div>
        </div>

        {tab === 'note' && (
          <section className="mp-mine">
            <div className="my-notes-editor"><NoteEditor value={mine} onChange={keep} readOnly={false} placeholder="Type your notes for this meeting" autoFocus /></div>
            {saveError ? <p className="set-error" role="alert">{saveError}</p> : savedTo && !mine.trim() ? <p className="muted">Saved to {savedTo.replace(/^MyBrain\//, '')}</p> : null}
          </section>
        )}
        {tab === 'transcript' && (
          <section className="mp-mine">
            <p className="muted">Nothing recorded for this meeting yet. Record starts a transcript with this meeting's title, and your notes from the Note tab come with it.</p>
          </section>
        )}

        {tab === 'prep' && <>
        {vaultPrep ? <VaultPrep event={e} onOpenNote={onOpenNote} /> : <section className="mp-section mp-prep">
          <h2>Meeting prep notes</h2>
          {loading ? <Skeleton lines={4} />
            : brief?.prep ? <>
              {brief.sources && <p className="muted" role="status">{brief.sources}</p>}
              <Markdown text={reveal(brief.prep)} onWiki={onWiki} />
              {oneOffFoot}
            </>
            : <><p className="mp-empty" role="status">{emptyText}</p>{anywayFoot}</>}
        </section>}

        <section className="mp-section">
          <h2>About this meeting</h2>
          {/* with the vault prep note in the Prep section, the one-off brief's sources and Regenerate sit here */}
          {vaultPrep && !loading && brief?.oneOff && brief.sources && <p className="muted" role="status">{brief.sources}</p>}
          {ABOUT.map(([key, label]) => (
            <div key={key} className="mp-about">
              <h3>{label}</h3>
              {loading ? <Skeleton lines={2} />
                : brief?.[key] ? <p>{reveal(brief[key])}</p>
                : <p className="mp-empty">{data?.status === 'few' ? `Shows after ${min} ${min === 1 ? 'meeting' : 'meetings'}.` : 'Not written yet.'}</p>}
            </div>
          ))}
          {!loading && (canAnyway ? anywayFoot : vaultPrep ? oneOffFoot : null)}
        </section>

        {(() => {
          // the series and the meetings its people also attend, newest first, each saying how it is connected
          const rows = [
            ...(data?.past ?? []).map((p) => ({ file: p.file, title: p.title, date: p.date, why: 'Repeats' })),
            ...(data?.related ?? []).map((r) => ({ file: r.file, title: r.title, date: r.date, why: `With ${r.shared.slice(0, 2).join(', ')}${r.shared.length > 2 ? ` +${r.shared.length - 2}` : ''}` })),
          ].sort((x, y) => String(y.date ?? '').localeCompare(String(x.date ?? '')));
          if (!rows.length) return null;
          // five at first; Show more adds up to ten more
          return (
            <section className="mp-section">
              <div className="mp-head"><h2>Related meetings</h2>{rows.length > 5 && <button className="up-all" aria-expanded={relatedAll} onClick={() => setRelatedAll((x) => !x)}>{relatedAll ? 'Show less' : 'Show more'}</button>}</div>
              <div className="mp-past">
                {rows.slice(0, relatedAll ? 15 : 5).map((p) => (
                  <button key={p.file} className="mp-past-row" onClick={() => onOpenNote(p.file)}>
                    <span className="mp-past-title">{p.title}</span><span className="mp-why">{p.why}</span><span className="muted">{p.date ? dayLabel(new Date(p.date)) : 'Undated'}</span>
                  </button>
                ))}
              </div>
            </section>
          );
        })()}
        </>}
      </article>
      <MeetingChat key={e.id} event={e} />
    </div>
  );
}
