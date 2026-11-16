import { useEffect, useState } from 'react';
import type { IgnoreRule, RuleRecord } from './quorum';
import { EmptyState, Row } from './controls';
import { IconListCheck } from './icons';

// Settings > Memory: each Memory health rule with its decisions from the decision log and what it does now, and the
// ignore rules the person accepted. The records are information only; Apply memory fixes on its own is the one switch
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function MemoryRulesCard() {
  const [records, setRecords] = useState<RuleRecord[] | null>(null);
  const [ignores, setIgnores] = useState<IgnoreRule[]>([]);
  const [busy, setBusy] = useState('');
  const load = () => {
    window.quorum.memoryRuleRecords().then(setRecords).catch(() => setRecords([]));
    window.quorum.memoryIgnoreList().then(setIgnores).catch(() => setIgnores([]));
  };
  useEffect(() => {
    load();
    return window.quorum.onMemoryUpdates?.(load);
  }, []);
  const remove = async (id: string) => {
    setBusy(id);
    try { await window.quorum.memoryIgnoreRemove(id); load(); } finally { setBusy(''); }
  };
  return (
    <>
      <h3>Rules</h3>
      <div className="set-card mr-rules">
        {(records ?? []).map((r) => (
          <div key={r.id} className="set-line mr-rule">
            <span className="mr-name"><strong>{r.label}</strong><span className="muted">{r.state}{r.ignores ? `. ${plural(r.ignores, 'ignore rule')}` : ''}</span></span>
            <span className="mr-counts" aria-label={`Decisions for ${r.label}`}>
              <span className="mr-count" data-tip="Open in Needs review">{r.open} open</span>
              <span className="mr-count">{r.approved} approved</span>
              <span className="mr-count">{r.archived} archived</span>
              <span className="mr-count">{r.undone} undone</span>
              <span className="mr-count">{r.auto} applied on its own</span>
              {/* the live precision guard: under 90% approved over 10 or more decisions */}
              {r.demoted && <span className="mr-count" data-tip="Its fixes wait under Check these first, and Apply memory fixes on its own skips them">Demoted: {r.demoted.approved} of {r.demoted.total} approved</span>}
            </span>
          </div>
        ))}
        {records !== null && !records.length && <p className="set-note">Connect a vault to see the rules.</p>}
      </div>
      <h3>Ignore rules</h3>
      {ignores.length ? (
        <div className="set-card">
          {ignores.map((g) => (
            <Row key={g.id} icon={<IconListCheck width={18} height={18} />} title={g.title} desc={`Added ${new Date(g.at).toLocaleDateString()}. Quorum keeps it in its settings, never in the vault.`}>
              <button className="pill small-pill" disabled={busy === g.id} onClick={() => remove(g.id)}>Remove</button>
            </Row>
          ))}
        </div>
      ) : (
        <EmptyState icon={<IconListCheck width={18} height={18} />} title="No ignore rules">
          <p className="set-hint">When you archive the same kind of finding three times, Quorum asks in Needs review whether to stop flagging it.</p>
        </EmptyState>
      )}
    </>
  );
}
