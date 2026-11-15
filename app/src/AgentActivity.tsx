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
  useEffect(() => {
    if (!file) { setAct(null); return; }
    let on = true;
    const load = () => window.quorum.noteActivity(file).then((r) => { if (on) setAct(r); }).catch(() => {});
    load();
    const off = window.quorum.onKeeper?.(() => load());
    const again = live ? window.setInterval(load, 2000) : 0;
    return () => { on = false; off?.(); if (again) window.clearInterval(again); };
  }, [file, live]);
  return act;
}

// What Quorum's agent did with this note, newest first: saving it, writing its summary, naming it, and each upkeep run
// with the notes it filed it into (index, daily note, people, projects, facts). Its cluster in the memory graph, and
// links to open it in Memory or in the graph. For debugging and audit as much as for reading
export function AgentActivity({ file }: { file: string }) {
  const act = useNoteActivity(file);
  if (!act) return null;
  return (
    <section className="mp-section agent-activity" id="agent-activity" aria-label="Agent activity">
      <div className="aa-head">
        <h2>Agent activity</h2>
        <span className="aa-actions">
          {act.cluster ? <span className="aa-cluster" data-tip="The cluster this note belongs to in your memory graph">Cluster: {act.cluster}</span>
            : <span className="aa-cluster" data-tip="Not in a graph cluster yet; the folder it is filed in">Folder: {act.folder}</span>}
          <button className="act-pill" onClick={() => openMemory(act.abs)}>Open in Memory</button>
          <button className="act-pill" onClick={() => openGraph(act.abs)}>View in graph</button>
        </span>
      </div>
      {!act.on && <p className="muted aa-off">Upkeep is off, so Quorum does not file this note into your memory. Turn it on in Settings, Memory.</p>}
      {act.pending && <p className="aa-row"><span className="aa-when">now</span><span className="shimmer">Filing this note: checking related notes, adding links, updating the index</span></p>}
      {!act.events.length && !act.pending && <p className="muted">{act.filedBefore ? 'Filed into your memory before this log started. The next save shows each step here.' : 'Nothing yet. Quorum files this note into your memory after you save it.'}</p>}
      <ol className="aa-list">
        {act.events.map((e, i) => (
          <li key={`${e.at}-${i}`} className="aa-row">
            <span className="aa-when" title={new Date(e.at).toLocaleString()}>{ago(e.at)}</span>
            <span className="aa-text">{e.text}</span>
            {!!e.files?.length && <span className="aa-files">{e.files.map((f) => <button key={f.abs} className="keeper-link" data-tip={f.rel} onClick={() => openMemory(f.abs)}>{f.label}</button>)}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

// The card at the top of a page after Save: the agent's steps shimmer under the title while upkeep files the note,
// then what it did in total, with Details to open the Agent activity section
export function AgentRun({ file, since, onDetails, onClose }: { file: string; since: number; onDetails: () => void; onClose: () => void }) {
  const [steps, setSteps] = useState<string[]>([]);
  const [late, setLate] = useState(false);
  const act = useNoteActivity(file, true);
  const run = act?.events.find((e) => e.kind === 'filed' && new Date(e.at).getTime() >= since - 1000) ?? null;
  const done = !!run || (act !== null && !act.on);
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
