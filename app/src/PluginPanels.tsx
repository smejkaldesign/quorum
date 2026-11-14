import { useEffect, useState } from 'react';
import type { BrainCheckItem, BrainCheckResult, BrainCheckStatus, ContextBudget, ContextFile, SkillUsage, SkillUse } from './quorum';

// the result a report plugin shows under its row in Settings › Memory › Plugins, while the row is Quorum's
const n = (v: number) => v.toLocaleString('en-US');
const SCOPE: Record<ContextFile['scope'], string> = { user: 'every session, all projects', project: 'every session', memory: 'every session', nested: 'only when Claude works in that folder', paths: 'only for the files its paths match' };

export function ContextPanel() {
  const [c, setC] = useState<ContextBudget | null | undefined>(undefined);
  const load = () => window.quorum.pluginContext().then(setC).catch(() => setC(null));
  useEffect(() => { load(); }, []);
  if (c === undefined) return <div className="plugin-detail"><p className="plugin-line">Measuring…</p></div>;
  if (!c) return null;
  const share = c.quorum
    ? c.quorum.share != null
      ? `Quorum's learned block: ${n(c.quorum.chars)} characters in ${c.quorum.path}, ${Math.round(c.quorum.share * 100)}% of each session.`
      : `Quorum's learned block: ${n(c.quorum.chars)} characters in ${c.quorum.path}, which loads only when Claude works in that folder.`
    : 'Quorum has written no learned facts here.';
  return (
    <div className="plugin-detail">
      <p className="plugin-line"><strong>About {n(c.total.tokens)} tokens</strong> ({n(c.total.chars)} characters) load in every session.</p>
      {c.files.map((f) => (
        <div key={f.abs} className="plugin-item">
          <span className="plugin-path">{f.path}</span>
          <span className="plugin-meta">{n(f.chars)} characters, {n(f.lines)} lines · {SCOPE[f.scope]}{f.importedBy ? ` · imported by ${f.importedBy}` : ''}</span>
          {f.warn && <span className="plugin-warn">{f.warn}</span>}
        </div>
      ))}
      <p className="plugin-line">{share}</p>
      {c.quorum?.aside && <p className="plugin-line muted">The facts themselves are in {c.quorum.aside.path} ({n(c.quorum.aside.chars)} characters), which Claude Code does not load on its own.</p>}
      {c.agent?.cut ? <p className="plugin-line plugin-warn">Quorum's own agent reads the first {n(c.agent.limit)} characters of {c.agent.path}, so the last {n(c.agent.cut)} are left out of its answers{c.agent.learnedCut ? ', including part of the learned facts' : ''}.</p> : null}
      <p className="plugin-line muted">Advice only. Quorum does not change these files.</p>
      <button className="pill small-pill" onClick={load}>Measure again</button>
    </div>
  );
}

// skill usage: the counts come from transcripts read on this Mac. Stash and unstash change one SKILL.md each, and only
// on a click; a skill another skill names asks once more before it is stashed
const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
export function SkillsPanel() {
  const [u, setU] = useState<SkillUsage | null | undefined>(undefined);
  const [win, setWin] = useState(90);
  const [asking, setAsking] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { window.quorum.pluginSkills().then(setU).catch(() => setU(null)); }, []);
  if (u === undefined) return <div className="plugin-detail"><p className="plugin-line">Reading transcripts on this Mac…</p></div>;
  if (!u) return null;
  if (!u.skills.length) return <div className="plugin-detail"><p className="plugin-line muted">No skills in .claude/skills.</p></div>;
  const stash = async (s: SkillUse, on: boolean) => {
    if (on && s.namedBy.length && asking !== s.dir) { setAsking(s.dir); return; }
    setAsking(null);
    setErr(null);
    try { setU(await window.quorum.pluginSkillStash(s.dir, on)); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const unused = u.skills.filter((s) => s.unused[win] && !s.stashed);
  const stashed = u.skills.filter((s) => s.stashed);
  const used = u.skills.filter((s) => s.runs > 0).sort((a, b) => b.runs - a.runs).slice(0, 5);
  return (
    <div className="plugin-detail">
      <p className="plugin-line">
        <strong>{unused.length} of {u.skills.length} skills</strong> have no recorded run in {win} days.
        {' '}From {n(u.transcripts)} {u.transcripts === 1 ? 'transcript' : 'transcripts'} on this Mac{u.transcripts ? `, going back ${n(u.coverageDays)} days` : ''}.
      </p>
      <div className="plugin-item row">
        {u.windows.map((w) => <button key={w} className={`pill small-pill${w === win ? ' primary' : ''}`} onClick={() => setWin(w)}>{w} days</button>)}
      </div>
      {u.coverageDays < win && <p className="plugin-line muted">The transcripts cover less than {win} days, so a skill listed here may have run before they start.</p>}
      {used.length > 0 && <p className="plugin-line muted">Most used: {used.map((s) => `${s.name} (${s.runs})`).join(', ')}</p>}
      {unused.map((s) => (
        <div key={s.dir} className="plugin-item">
          <div className="plugin-item row">
            <span className="plugin-path">{s.name}</span>
            <span className="plugin-meta">{s.last ? `last ran ${day(s.last)}` : 'no recorded run'}</span>
            <button className="pill small-pill" onClick={() => stash(s, true)}>{asking === s.dir ? 'Stash anyway' : 'Stash'}</button>
          </div>
          {asking === s.dir && <span className="plugin-warn">Named by {s.namedBy.join(', ')}. Stashed, it still runs when you type /{s.name}, but the model no longer picks it on its own.</span>}
        </div>
      ))}
      {stashed.length > 0 && <p className="plugin-line muted">Stashed: the model does not see these, and /name still runs them.</p>}
      {stashed.map((s) => (
        <div key={s.dir} className="plugin-item row">
          <span className="plugin-path">{s.name}</span>
          <button className="pill small-pill" onClick={() => stash(s, false)}>Unstash</button>
        </div>
      ))}
      {err && <p className="plugin-line plugin-warn">{err}</p>}
      <p className="plugin-line muted">Stash adds disable-model-invocation: true to that skill's SKILL.md and changes nothing else. Transcripts stay on this Mac.</p>
    </div>
  );
}

// brain check: the questions and their expected terms are edited here; Run asks each one that has terms on the
// person's own model source. Each result shows next to the run before it, so a change after a model or rules edit shows
const MAX_CHECKS = 6;
const verdict = (r: BrainCheckResult | undefined) => (!r ? null : r.error ? 'Failed to run' : r.pass ? 'Pass' : `Fail, missing ${r.missing.join(', ')}`);
export function BrainCheckPanel() {
  const [s, setS] = useState<BrainCheckStatus | null | undefined>(undefined);
  const [draft, setDraft] = useState<{ id: string; prompt: string; terms: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // the draft is filled from the saved checks once; after that it is the user's, so a save or a finished run never
  // resets it, and results are matched to rows by check id
  const fill = (st: BrainCheckStatus | null) => { setS(st); if (st) setDraft(st.checks.map((c) => ({ id: c.id, prompt: c.prompt, terms: c.expect.join(', ') }))); };
  useEffect(() => {
    window.quorum.brainCheckStatus().then(fill).catch(() => setS(null));
    return window.quorum.onBrainCheck?.(() => { window.quorum.brainCheckStatus().then(setS).catch(() => {}); });
  }, []);
  if (!s) return null;
  const toItems = (d: typeof draft): BrainCheckItem[] => d.map((c) => ({ id: c.id, prompt: c.prompt, expect: c.terms.split(',').map((t) => t.trim()).filter(Boolean) }));
  // only rows with a question are saved; a blank row stays on screen until the user fills it or removes it
  const save = async (d = draft) => { try { setS(await window.quorum.brainCheckSave(toItems(d.filter((c) => c.prompt.trim())))); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } };
  const edit = (i: number, k: 'prompt' | 'terms', v: string) => setDraft(draft.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  const run = async () => { setErr(null); try { await save(); setS(await window.quorum.brainCheckRun()); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } };
  const now = (id: string) => s.last?.results.find((r) => r.id === id);
  const before = (id: string) => s.previous?.results.find((r) => r.id === id);
  const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <div className="plugin-detail">
      {s.changed.length > 0 && !s.running && <p className="plugin-line plugin-warn">Changed since the last run: {s.changed.join(', ')}. Run the checks again to compare.</p>}
      <p className="plugin-line">
        {s.running ? `Running, ${s.done} of ${s.ready} done…` : s.last ? `Last run ${when(s.last.at)}: ${s.last.results.filter((r) => r.pass).length} of ${s.last.results.length} passed.` : 'Not run yet.'}
        {' '}A check runs once it has expected terms.
      </p>
      {draft.map((c, i) => {
        const r = now(c.id);
        const p = before(c.id);
        return (
          <div key={c.id} className="plugin-item check-item">
            <label className="set-field wide"><input value={c.prompt} aria-label="Question" placeholder="Question" onChange={(e) => edit(i, 'prompt', e.target.value)} onBlur={() => save()} /></label>
            <label className="set-field wide"><input value={c.terms} aria-label="Expected terms" placeholder="Expected terms, separated by commas" onChange={(e) => edit(i, 'terms', e.target.value)} onBlur={() => save()} /></label>
            {r && <span className={r.pass ? 'plugin-pass' : 'plugin-fail'}>{verdict(r)}{p ? ` · run before: ${verdict(p)}` : ''}</span>}
            {r && (
              <details>
                <summary className="plugin-meta">Answers</summary>
                <p className="plugin-line">{r.error ?? r.answer}</p>
                {p && <p className="plugin-line muted">Run before: {p.error ?? p.answer}</p>}
              </details>
            )}
            <button className="link-btn plugin-meta" onClick={() => { const d = draft.filter((_, j) => j !== i); setDraft(d); save(d); }}>Remove</button>
          </div>
        );
      })}
      <div className="plugin-item row">
        <button className="pill small-pill primary" disabled={s.running || !draft.some((c) => c.terms.trim() && c.prompt.trim())} onClick={run}>{s.running ? 'Running…' : 'Run'}</button>
        {draft.length < MAX_CHECKS && <button className="pill small-pill" onClick={() => setDraft([...draft, { id: `check-${Date.now()}`, prompt: '', terms: '' }])}>Add a check</button>}
      </div>
      {err && <p className="plugin-line plugin-warn">{err}</p>}
      <p className="plugin-line muted">Runs on your own model source in AI settings, only when you press Run. Answers stay in Quorum on this Mac.</p>
    </div>
  );
}
