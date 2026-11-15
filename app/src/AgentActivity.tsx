import { useEffect, useRef, useState } from 'react';
import markProd from '../assets/quorum-mark.png';
import type { NoteActivity } from './quorum';

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const openMemory = (abs: string) => window.dispatchEvent(new CustomEvent('quorum:open-memory', { detail: abs }));
const openGraph = (abs: string) => window.dispatchEvent(new CustomEvent('quorum:open-graph', { detail: abs }));

// a note's upkeep record, read again whenever upkeep finishes a run, and every few seconds while live is set
export function useNoteActivity(file: string | null, live = false) {
  const [act, setAct] = useState<NoteActivity | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!file) { setAct(null); return; }
    let on = true;
    const load = () => window.quorum.noteActivity(file).then((r) => { if (on) setAct(r); }).catch(() => {});
    load();
    const off = window.quorum.onKeeper?.(() => load());
    const again = live ? window.setInterval(load, 2000) : 0;
    return () => { on = false; off?.(); if (again) window.clearInterval(again); };
  }, [file, live, n]);
  return [act, () => setN((x) => x + 1)] as const;
}

// what counts as new for the bell: the agent's events since the person last opened Notifications, and a note Quorum
// wrote that nobody has reviewed. The person's own saves and edits never do
const byYou = (e: NoteActivity['events'][number]) => e.text.startsWith('You');
export function unseenOf(act: NoteActivity | null) {
  if (!act) return 0;
  const since = act.seenAt ? new Date(act.seenAt).getTime() : 0;
  return act.events.filter((e) => !byYou(e) && new Date(e.at).getTime() > since).length + (act.agentWritten && !act.reviewedAt ? 1 : 0);
}

// A saved note's Notifications: what Quorum's agent did with it (wrote it, linked it to memories, referenced it in an
// answer, updated it, named it) and what the person did, newest first. A note Quorum wrote waits at the top until it
// is reviewed. Rows that arrived since the person last looked keep a dot while the tab is open. The cluster (or
// folder) and the links to Memory and the graph sit above the list. Mentions and share requests from teammates
// belong here too once a note is shared
export function NoteNotifications({ act, seenBefore, onReviewed }: { act: NoteActivity | null; seenBefore: string | null; onReviewed: () => void }) {
  if (!act) return null;
  const since = seenBefore ? new Date(seenBefore).getTime() : 0;
  const fresh = (e: NoteActivity['events'][number]) => !byYou(e) && new Date(e.at).getTime() > since;
  return (
    <section className="note-notifs" id="agent-activity" aria-label="Notifications">
      <div className="aa-head">
        <span className="aa-actions">
          {act.cluster ? <span className="aa-cluster" data-tip="The cluster this note belongs to in your memory graph">Cluster: {act.cluster}</span>
            : <span className="aa-cluster" data-tip="Not in a graph cluster yet; the folder it is filed in">Folder: {act.folder}</span>}
        </span>
        <span className="aa-actions">
          <button className="act-pill" onClick={() => openMemory(act.abs)}>Open in Memory</button>
          <button className="act-pill" onClick={() => openGraph(act.abs)}>View in graph</button>
        </span>
      </div>
      <ol className="nn-list">
        {act.agentWritten && !act.reviewedAt && (
          <li className="nn-row unread">
            <span className="nn-who"><img src={markProd} alt="" width={22} height={22} /></span>
            <span className="nn-body"><span className="nn-text">Quorum wrote this note. Review it before you rely on it or share it.</span></span>
            <button className="act-pill primary" onClick={async () => { await window.quorum.noteReviewed(act.abs); onReviewed(); }}>Mark reviewed</button>
          </li>
        )}
        {act.pending && (
          <li className="nn-row">
            <span className="nn-who"><img src={markProd} alt="" width={22} height={22} /></span>
            <span className="nn-body"><span className="nn-text shimmer">Agent is filing this note: checking related notes, adding links, updating the index</span><span className="nn-when">now</span></span>
          </li>
        )}
        {act.events.map((e, i) => (
          <li key={`${e.at}-${i}`} className={`nn-row${fresh(e) ? ' unread' : ''}`}>
            <span className="nn-who">{byYou(e) ? <span className="nn-you" aria-label="You">You</span> : <img src={markProd} alt="Quorum" width={22} height={22} />}</span>
            <span className="nn-body">
              <span className="nn-text">{e.text}</span>
              {!!e.files?.length && <span className="aa-files">{e.files.map((f) => <button key={f.abs} className="keeper-link" data-tip={f.rel} onClick={() => openMemory(f.abs)}>{f.label}</button>)}</span>}
              <span className="nn-when" title={new Date(e.at).toLocaleString()}>{ago(e.at)}</span>
            </span>
          </li>
        ))}
      </ol>
      {!act.on && <p className="muted aa-off">Upkeep is off, so Quorum does not link this note into your memory. Turn it on in Settings, Memory.</p>}
      {!act.events.length && !act.pending && <p className="muted">{act.filedBefore ? 'Filed into your memory before this log started. The next save lists each step here.' : 'Nothing yet. Quorum links this note into your memory after you save it.'}</p>}
    </section>
  );
}

// The card at the top of a page after Save: the agent's steps shimmer under the title while upkeep files the note,
// then what it did in total, with Details to open the Agent activity section
export function AgentRun({ file, since, onDetails, onClose }: { file: string; since: number; onDetails: () => void; onClose: () => void }) {
  const [steps, setSteps] = useState<string[]>([]);
  const [late, setLate] = useState(false);
  const [finished, setFinished] = useState(false);
  const [act] = useNoteActivity(file, !finished);
  const run = act?.events.find((e) => e.kind === 'filed' && new Date(e.at).getTime() >= since - 1000) ?? null;
  const done = !!run || (act !== null && !act.on);
  useEffect(() => { if (done || late) setFinished(true); }, [done, late]);
  const fileRef = useRef(file);
  fileRef.current = file;
  useEffect(() => window.quorum.onKeeperStep?.((d) => { if (d.file === fileRef.current) setSteps((s) => [...s, d.text].slice(-4)); }), []);
  useEffect(() => { const t = window.setTimeout(() => setLate(true), 60000); return () => window.clearTimeout(t); }, [since]);
  const n = run?.files?.length ?? 0;
  return (
    <div className={`sum-wait agent-run${done ? ' done' : ''}`} role="status" aria-live="polite">
      <div className="ar-top">
        {done || late ? <img src={markProd} alt="" width={18} height={18} /> : <span className="spinner" aria-hidden="true" />}
        <strong>{!act?.on && act ? 'Saved' : run ? 'Saved and filed' : late ? 'Saved' : 'Saving and filing your note'}</strong>
        <span className="ar-actions">
          {done && <button className="act-pill" onClick={onDetails}>Details</button>}
          {(done || late) && <button className="text-btn" onClick={onClose}>Close</button>}
        </span>
      </div>
      {!done && !late && (
        <ul className="ar-steps">
          {(steps.length ? steps : ['Checking related notes']).map((s, i, all) => <li key={`${s}-${i}`} className={i === all.length - 1 ? 'shimmer' : ''}>{s}</li>)}
        </ul>
      )}
      {done && <p className="ar-result">{!act?.on ? 'Upkeep is off, so the note was not filed into your memory.' : n ? `Filed into ${n} ${n === 1 ? 'note' : 'notes'}: ${run!.files!.map((f) => f.label).join(', ')}.` : 'Checked related notes and links. Nothing else needed an update.'}</p>}
      {!done && late && <p className="ar-result">Upkeep has not filed it yet. It runs again after the next save.</p>}
    </div>
  );
}
