import { useEffect, useRef, useState } from 'react';
import type { MeetingMeta, Notes } from './quorum';
import mark from '../assets/quorum-mark.png';
import { Markdown } from './Markdown';
import { IconArrowUp, IconCalendar, IconClock, IconFolder, IconLogs, IconNotes, IconPeople } from './icons';

type Followup = { q: string; a: string | null };

// Granola-sized end-of-call note: title, meta pills, sectioned notes, follow-up composer
export type Turn = { channel: 'me' | 'them'; who: string; text: string };

export function EndView({ notes, meta, summarizing, transcript, onClose }: { notes: Notes | null; meta: MeetingMeta | null; summarizing: boolean; transcript: Turn[]; onClose: () => void }) {
  const [showing, setShowing] = useState<'summary' | 'transcript'>('summary');
  const [kept, setKept] = useState<Record<number, boolean>>({});
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState<{ file: string; rel: string; app: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => { if (notes) setKept(Object.fromEntries(notes.nextSteps.map((_, i) => [i, true]))); }, [notes]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [followups]);

  async function ask() {
    const q = draft.trim();
    if (!q) return;
    setDraft('');
    setFollowups((f) => [...f, { q, a: null }]);
    let a: string;
    try { a = (await window.quorum.ask(q)).text; } catch (err) { a = `Couldn't answer: ${String(err).replace(/^Error:\s*/, '')}`; }
    setFollowups((f) => f.map((x, i) => (i === f.length - 1 ? { ...x, a } : x)));
  }

  async function save() {
    if (!notes) return;
    setSaving(true);
    try {
      const r = await window.quorum.saveNotes({
        notes: { ...notes, nextSteps: notes.nextSteps.filter((_, i) => kept[i]) },
        followups: followups.filter((f): f is { q: string; a: string } => !!f.a),
      });
      setSaved(r);
    } finally { setSaving(false); }
  }

  const started = meta?.startedAt ? new Date(meta.startedAt) : null;
  const when = started ? (started.toDateString() === new Date().toDateString() ? 'Today' : started.toLocaleDateString()) : 'Today';

  return (
    <div className="panel end">
      <header className="end-bar">
        <button className="pill ghost" onClick={async () => { await window.quorum.discard(); onClose(); }}>{saved ? 'Close' : 'Discard'}</button>
        <div className="end-actions">
          {saved ? (
            <>
              <span className="saved">Saved to {saved.rel.replace(/^MyBrain\//, '')}</span>
              <button className="pill" onClick={() => window.quorum.openNote(saved.file)}><IconFolder width={15} height={15} /> Show in {saved.app}</button>
            </>
          ) : (
            <button className="pill primary" disabled={!notes || saving} onClick={save}>{saving ? 'Saving…' : 'Save to vault'}</button>
          )}
        </div>
      </header>

      {summarizing || !notes ? (
        <div className="end-loading">
          <span className="spinner big" />
          <p>Summarizing call…</p>
        </div>
      ) : (
        <div className="end-scroll">
          <article className="doc">
            <h1>{notes.title}</h1>
            <div className="meta-row">
              <span className="meta-pill"><IconCalendar width={16} height={16} />{when}{started ? ` · ${started.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}</span>
              {meta && meta.minutes > 0 && <span className="meta-pill"><IconClock width={16} height={16} />{meta.minutes} min</span>}
              {meta && meta.participants > 0 && <span className="meta-pill"><IconPeople width={16} height={16} />{meta.participants}</span>}
              {meta && <span className="meta-pill">Claude {meta.model[0].toUpperCase() + meta.model.slice(1)}</span>}
              <div className="view-toggle" role="group" aria-label="Show">
                <button className={showing === 'summary' ? 'on' : ''} aria-pressed={showing === 'summary'} aria-label="Summary" data-tip="Summary" onClick={() => setShowing('summary')}><IconNotes width={16} height={16} /></button>
                <button className={showing === 'transcript' ? 'on' : ''} aria-pressed={showing === 'transcript'} aria-label="Transcript" data-tip="Transcript" onClick={() => setShowing('transcript')}><IconLogs width={16} height={16} /></button>
              </div>
            </div>

            {showing === 'transcript' ? (
              <section className="transcript end-transcript">
                {transcript.length ? transcript.map((t, i) => <p key={i} className={t.channel}><span>{t.who}</span><div>{t.text}</div></p>) : <p className="muted">Nothing was transcribed.</p>}
              </section>
            ) : <>
            {notes.empty && <p className="muted">Nothing was transcribed in this call.</p>}
            {notes.sections.map((sec, i) => (
              <section key={i} className="doc-section">
                <h2><span className="hash">#</span>{sec.heading}</h2>
                <ul>
                  {sec.bullets.map((b, j) => (
                    <li key={j}>{b.text}{b.sub?.length > 0 && <ul>{b.sub.map((s, k) => <li key={k}>{s}</li>)}</ul>}</li>
                  ))}
                </ul>
              </section>
            ))}
            {notes.nextSteps.length > 0 && (
              <section className="doc-section">
                <h2><span className="hash">#</span>Next steps</h2>
                {notes.nextSteps.map((n, i) => (
                  <label key={i} className="item">
                    <input type="checkbox" checked={!!kept[i]} onChange={(e) => setKept((k) => ({ ...k, [i]: e.target.checked }))} />
                    <span>{n.title}<em> · {n.owner ?? 'no owner'}</em></span>
                  </label>
                ))}
                <p className="hint left">Unchecked items are left out of the saved note.</p>
              </section>
            )}
            </>}

            {followups.length > 0 && (
              <section className="doc-section">
                <h2><span className="hash">#</span>Follow-ups</h2>
                {followups.map((f, i) => (
                  <div key={i} className="followup">
                    <div className="user-msg">{f.q}</div>
                    <div className="quorum-row">
                      <img className="avatar" src={mark} alt="Quorum" />
                      <div className="card">{f.a === null ? <p className="muted thinking">Thinking…</p> : <Markdown text={f.a} />}</div>
                    </div>
                  </div>
                ))}
              </section>
            )}
            <div ref={end} />
          </article>
        </div>
      )}

      <div className="end-composer-wrap">
        <form className="end-composer" onSubmit={(e) => { e.preventDefault(); ask(); }}>
          <input value={draft} placeholder="Any follow-ups?" disabled={!notes || summarizing} onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" className="send" aria-label="Ask" disabled={!draft.trim()}><IconArrowUp /></button>
        </form>
        <p className="disclaimer">Quorum uses AI and can make mistakes.</p>
      </div>
    </div>
  );
}
