import { useEffect, useState } from 'react';
import type { MemorySetupReport, MemorySetupStatus, ModelPassStatus } from './quorum';
import { BY_ID } from '../connectors/catalog';
import { Row, Toggle } from './controls';
import { IconBrain, IconCheck, IconClock, IconInfo, IconListCheck, IconNotes, IconSliders } from './icons';
import { keeperRow, modelEstimateText, modelStateText, percent, phaseName } from './memorySetupView';

const n = (x: number) => x.toLocaleString('en-US');
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;
const day = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function found(r: MemorySetupReport) {
  const c = r.counts;
  const e = c.entities;
  const embed = c.embeddings ? (c.embeddings.built >= c.embeddings.total ? `${plural(c.embeddings.total, 'passage')} embedded for search` : `Embedding ${n(c.embeddings.built)} of ${n(c.embeddings.total)} passages in the background`) : 'The search index is not built yet';
  return [
    plural(c.notes, 'note'),
    `${n(c.links.resolved)} of ${plural(c.links.total, 'link')} open a note`,
    `${plural(e.people, 'person', 'people')}, ${plural(e.projects, 'project')}, ${plural(e.meetings, 'meeting')}, ${plural(e.decisions, 'decision')}`,
    embed,
  ].join(' · ');
}
function fresh(r: MemorySetupReport) {
  const f = r.freshness;
  const share = f.confirmed == null ? null : `${Math.round(f.confirmed * 100)}% of ${f.basis === 'facts' ? 'facts' : 'notes'} ${f.basis === 'facts' ? 'confirmed' : 'updated or verified'} in the last ${f.days} days`;
  return [share, plural(f.contradictions, 'open contradiction'), plural(f.staleSummaries, 'stale summary', 'stale summaries')].filter(Boolean).join(' · ');
}

const message = (e: unknown) => String((e as Error)?.message || e);
const KEEPER_TITLE = 'Update the vault after each meeting';

// Memory setup: what the scan found in the vault, what Quorum will fix (each gap waits in Memory health, Needs review),
// freshness, the keeper and the model pass. In onboarding for a vault the person connects (offerKeeper), the keeper is
// shown selected and turns on only when the person finishes setup with it selected or toggles it (memorySetupView.ts
// keeperRow); in Settings, Memory, the toggle sets it
export function MemorySetupCard({ offerKeeper = false, heading = true }: { offerKeeper?: boolean; heading?: boolean }) {
  const [s, setS] = useState<MemorySetupStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState('');
  const [error, setError] = useState('');
  const load = () => window.quorum.memorySetupStatus().then((st) => { setS(st); setFailed(''); setLoaded(true); }).catch((e) => { setFailed(message(e)); setLoaded(true); });
  useEffect(() => {
    let live = true;
    window.quorum.memorySetupStatus().then((st) => { if (live) { setS(st); setLoaded(true); } }).catch((e) => { if (live) { setFailed(message(e)); setLoaded(true); } });
    const off = window.quorum.onMemorySetup((p) => setS((prev) => (prev ? { ...prev, ...p } : prev)));
    return () => { live = false; off(); };
  }, []);
  const run = async () => { setError(''); try { const st = await window.quorum.memorySetupRun(); if (st) setS(st); } catch (e) { setError(message(e)); } };
  const keeper = async (on: boolean) => {
    setError('');
    if (s) setS({ ...s, keeper: { ...s.keeper, on }, keeperChoice: on ? 'on' : 'off' });
    try { const st = await window.quorum.memorySetupKeeper({ on }); if (st) setS(st); } catch (e) { setError(message(e)); }
  };
  if (loaded && !s && !failed) return null;
  return <MemorySetupView s={s} failed={failed} error={error} offerKeeper={offerKeeper} heading={heading} onRun={run} onKeeper={keeper} onRetry={() => { setFailed(''); setLoaded(false); load(); }} />;
}

// The card itself, from its status: a loading row before the first status, an error row when it did not load
export function MemorySetupView({ s, failed = '', error = '', offerKeeper = false, heading = true, onRun, onKeeper, onRetry }: {
  s: MemorySetupStatus | null; failed?: string; error?: string; offerKeeper?: boolean; heading?: boolean;
  onRun: () => void; onKeeper: (on: boolean) => void; onRetry: () => void;
}) {
  if (!s) {
    return (
      <>
        {heading && <h3>Memory setup</h3>}
        <div className="set-card ms-card" aria-busy={!failed}>
          {failed
            ? <Row icon={<IconInfo width={18} height={18} />} title="Memory setup did not load" desc={<span role="alert">{failed}</span>}><button className="pill" onClick={onRetry}>Try again</button></Row>
            : <Row icon={<IconBrain width={18} height={18} />} title="Memory setup" desc="Loading the last scan…" />}
        </div>
      </>
    );
  }
  const r = s.report;
  const gaps = r?.gaps.filter((g) => g.count > 0) ?? [];
  const pct = percent(s.progress);
  const k = keeperRow({ offer: offerKeeper, made: s.made, choice: s.keeperChoice ?? null, on: s.keeper.on });
  return (
    <>
      {heading && <h3>Memory setup</h3>}
      <div className="set-card ms-card">
        {/* the phase name is announced when it changes; the count beside it is not */}
        <span className="sr-only" aria-live="polite">{s.running ? phaseName(s) : r ? 'Memory set up' : ''}</span>
        {s.running && (
          <div className="src-progress ms-progress">
            <div className="src-progress-text" aria-hidden="true"><span>{s.progress?.label ?? 'Starting'}</span><span>{pct}%</span></div>
            <div className="src-bar" role="progressbar" aria-label={phaseName(s)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><div className="src-bar-fill" style={{ width: `${Math.max(4, pct)}%` }} /></div>
          </div>
        )}
        {(error || s.error) && <p className="set-error ms-error" role="alert">{error || s.error}</p>}
        {r && !s.running && (
          <Row icon={<IconCheck width={18} height={18} />} title="Memory set up" desc={`Quorum checked every note on ${day(r.at)}.`}>
            <button className="pill" onClick={onRun}>Check again</button>
          </Row>
        )}
        {!r && !s.running && (
          <Row icon={<IconBrain width={18} height={18} />} title="Set up your memory" desc="Quorum reads every note, builds the memory graph, and lists each gap it can fix in Memory health. The scan writes nothing to your notes.">
            <button className="pill primary" onClick={onRun}>Start</button>
          </Row>
        )}
        {r && (
          <>
            <Row icon={<IconBrain width={18} height={18} />} title="What Quorum found" desc={found(r)} />
            <Row icon={<IconListCheck width={18} height={18} />} title="What Quorum will fix"
              desc={gaps.length ? `${plural(r.fixes, 'fix', 'fixes')} wait in Memory health, Needs review. Each one runs when you approve it, with Undo.` : 'No gaps. Quorum keeps checking as your notes change.'} />
            {gaps.length > 0 && (
              <ul className="ms-gaps">
                {gaps.map((g) => <li key={g.id}><span>{g.label}</span><em>{n(g.count)}</em></li>)}
              </ul>
            )}
            <Row icon={<IconClock width={18} height={18} />} title="Freshness" desc={fresh(r)} />
            {r.outside.length > 0 && (
              <Row icon={<IconInfo width={18} height={18} />} title="Instruction files outside the vault"
                desc={`${r.outside.map((o) => `${o.file}: ${n(o.chars)} characters${o.over ? `, over the ${n(o.budget)} budget` : ''}${o.dead.length ? `, ${plural(o.dead.length, 'link')} to missing notes` : ''}`).join('. ')}. Quorum reads these and does not change them.`} />
            )}
          </>
        )}
        <Row icon={<IconNotes width={18} height={18} />} title={KEEPER_TITLE}
          desc={`After each meeting, Quorum adds a line to the index, the daily note, and each person and project note it names, and records who attended in the memory graph. It writes only files it made unless you allow more in Settings, Memory.${k.pending ? ' Selected: it turns on when you finish setup. Turn it off here to keep it off.' : ''}`}>
          <Toggle on={k.on} onChange={onKeeper} label={KEEPER_TITLE} />
        </Row>
        <ModelPassRow />
      </div>
    </>
  );
}

const MODEL_TITLE = 'Read the prose of your notes with your model';
const CAPS = [50000, 200000, 500000, 1000000, 3000000];
// The model pass (memoryModelPass.js): off until the person turns it on for this vault, with the estimate computed from
// the vault before it runs, the token cap per run, and Run now or Cancel
export function ModelPassRow() {
  const [m, setM] = useState<ModelPassStatus | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    window.quorum.memoryModelStatus().then((st) => { if (live) setM(st); }).catch((e) => { if (live) setError(message(e)); });
    // run events carry no estimate: the one shown stays, and is read again once a run ends
    const off = window.quorum.onMemoryModel((p) => {
      setM((prev) => ({ ...p, estimate: prev?.estimate ?? null }));
      if (!p.running) window.quorum.memoryModelStatus().then((st) => { if (live) setM(st); }).catch(() => {});
    });
    return () => { live = false; off(); };
  }, []);
  const act = async (fn: () => Promise<ModelPassStatus>) => { setError(''); try { setM(await fn()); } catch (e) { setError(message(e)); } };
  const source = m?.provider ? (BY_ID as Record<string, { name: string } | undefined>)[m.provider]?.name ?? m.provider : null;
  const state = m ? modelStateText(m) : '';
  return (
    <Row icon={<IconSliders width={18} height={18} />} title={MODEL_TITLE}
      desc={<>
        {`Quorum sends your notes to ${source ? `your ${source} model source` : 'your own model source'} to find the people, projects, relations and decisions their links and frontmatter do not show. Readings it is sure of join the memory graph marked as the model's, with the line they came from; the rest wait in Needs review for you. Notes that are private, confidential, opted out or on the never-listen list never go to the model. Off until you turn it on.`}
        <br />{m ? modelEstimateText(m.estimate) : 'Estimating…'}
        {state && <><br /><span aria-live="polite">{state}</span></>}
        {error && <><br /><span role="alert">{error}</span></>}
      </>}>
      {m?.on && (
        <select className="set-select" aria-label="Tokens per run" value={m.cap} onChange={(e) => act(() => window.quorum.memoryModelSet({ cap: Number(e.target.value) }))}>
          {CAPS.map((c) => <option key={c} value={c}>{`${c.toLocaleString('en-US')} tokens a run`}</option>)}
        </select>
      )}
      {m?.on && m.running && <button className="pill" onClick={() => act(() => window.quorum.memoryModelCancel())}>Cancel</button>}
      {m?.on && !m.running && !!m.estimate?.notes && <button className="pill" onClick={() => act(() => window.quorum.memoryModelRun())}>Run now</button>}
      <Toggle on={!!m?.on} disabled={!m} onChange={(on) => act(() => window.quorum.memoryModelSet({ on }))} label={MODEL_TITLE} />
    </Row>
  );
}
