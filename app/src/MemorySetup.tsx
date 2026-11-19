import { useEffect, useState } from 'react';
import type { MemorySetupReport, MemorySetupStatus } from './quorum';
import { Row, Toggle } from './controls';
import { IconBrain, IconCheck, IconClock, IconInfo, IconListCheck, IconNotes, IconSliders } from './icons';

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

// Memory setup: what the scan found in the vault, what Quorum will fix (each gap waits in Memory health, Needs review),
// freshness, the keeper and the model pass. In onboarding for a vault the person connects (offerKeeper turns the
// keeper on once, shown on), and in Settings, Memory
export function MemorySetupCard({ offerKeeper = false, heading = true }: { offerKeeper?: boolean; heading?: boolean }) {
  const [s, setS] = useState<MemorySetupStatus | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    window.quorum.memorySetupStatus().then(async (st) => {
      if (!live || !st) return;
      // a vault the person connected gets the keeper offered on; they can turn it off here
      if (offerKeeper && st.made !== 'quorum' && !st.keeper.on) {
        await window.quorum.keeperSet({ on: true }).catch(() => {});
        st = { ...st, keeper: { ...st.keeper, on: true } };
      }
      setS(st);
    }).catch(() => {});
    const off = window.quorum.onMemorySetup((p) => setS((prev) => (prev ? { ...prev, ...p } : prev)));
    return () => { live = false; off(); };
  }, [offerKeeper]);
  if (!s) return null;
  const r = s.report;
  const run = async () => { setError(''); try { const st = await window.quorum.memorySetupRun(); if (st) setS(st); } catch (e) { setError(String((e as Error).message || e)); } };
  const keeper = async (on: boolean) => { setS({ ...s, keeper: { ...s.keeper, on } }); await window.quorum.keeperSet({ on }).catch(() => {}); };
  const gaps = r?.gaps.filter((g) => g.count > 0) ?? [];
  const pct = s.progress ? Math.round((s.progress.done / Math.max(1, s.progress.total)) * 100) : 0;
  return (
    <>
      {heading && <h3>Memory setup</h3>}
      <div className="set-card ms-card">
        {s.running && (
          <div className="src-progress ms-progress" aria-live="polite">
            <div className="src-progress-text"><span>{s.progress?.label ?? 'Starting'}</span><span>{pct}%</span></div>
            <div className="src-bar"><div className="src-bar-fill" style={{ width: `${Math.max(4, pct)}%` }} /></div>
          </div>
        )}
        {(error || s.error) && <p className="set-error ms-error">{error || s.error}</p>}
        {r && !s.running && (
          <Row icon={<IconCheck width={18} height={18} />} title="Memory set up" desc={`Quorum checked every note on ${day(r.at)}.`}>
            <button className="pill" onClick={run}>Check again</button>
          </Row>
        )}
        {!r && !s.running && (
          <Row icon={<IconBrain width={18} height={18} />} title="Set up your memory" desc="Quorum reads every note, builds the memory graph, and lists each gap it can fix. Nothing changes until you approve it.">
            <button className="pill primary" onClick={run}>Start</button>
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
        <Row icon={<IconNotes width={18} height={18} />} title="Keep the vault in step after each meeting"
          desc="After each meeting, Quorum adds a line to the index, the daily note, and each person and project note it names, and records who attended in the memory graph. It writes only files it made unless you allow more in Settings, Memory.">
          <Toggle on={s.keeper.on} onChange={keeper} label="Keep the vault in step after each meeting" />
        </Row>
        <Row icon={<IconSliders width={18} height={18} />} title={<>Model pass <em className="soon grey">Later</em></>}
          desc="Reads the prose of your notes for relations and decisions with your own model source, and shows its cost before it runs. It comes in a later version." >
          <Toggle on={false} onChange={() => {}} disabled label="Model pass" />
        </Row>
      </div>
    </>
  );
}
