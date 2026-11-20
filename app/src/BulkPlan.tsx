import { DraftEvidence } from './MemoryDraft';
import { useEffect, useRef, useState } from 'react';
import type { PlanView } from './quorum';
import { IconChevron } from './icons';
import { Modal, ModalActions } from './controls';
import { toast } from './Toasts';

// the ticks the person changed, as the ids main leaves out and the check-first ids it adds back
const ticks = (picks: Map<string, boolean>) => ({ exclude: [...picks].filter(([, on]) => !on).map(([id]) => id), include: [...picks].filter(([, on]) => on).map(([id]) => id) });

// The bulk plan sheet (batchPlan.js): Approve on several items opens it at once with the
// loader, then shows what the batch will do as groups with counts, each folding open to its items, and what was merged,
// skipped or held back and why. Unticking a group or an item plans again without it. Fixes a person should read first
// (batchPlan.js checkFirst) list under Check these first, unticked until ticked. Apply runs the plan as one batch
// with the progress banner; Cancel changes nothing. ids: the row ids picked. It also offers to save the plan as a note (off unless ticked)
export function BulkPlan({ ids, onClose, onApplied }: { ids: string[]; onClose: () => void; onApplied: () => void }) {
  const [view, setView] = useState<PlanView | null>(null);
  // the ticks the person changed: id -> on. Main leaves out every check-first item that is not ticked here
  const [picks, setPicks] = useState<Map<string, boolean>>(new Map());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [saveNote, setSaveNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const asked = useRef(0);
  useEffect(() => {
    const n = ++asked.current;
    const { exclude, include } = ticks(picks);
    window.quorum.fixPlan(ids, exclude, include).then((v) => { if (n === asked.current) { setView(v); setError(''); } }).catch((e) => setError(String(e).replace(/^.*Error:\s*/, '')));
  }, [ids, picks]);
  const flip = (list: string[], on: boolean) => setPicks((s) => { const n = new Map(s); for (const id of list) n.set(id, on); return n; });
  const fold = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const apply = async () => {
    setBusy(true);
    try {
      const { exclude, include } = ticks(picks);
      const r = await window.quorum.fixPlanApply(ids, exclude, { saveNote }, include);
      toast(r.run ? `Applying ${r.run.items?.length ?? 0} ${r.run.items?.length === 1 ? 'fix' : 'fixes'} as one batch.${r.note ? ` Saved the plan as ${r.note}.` : ''}` : r.note ? `Saved the plan as ${r.note}. Nothing was applied.` : 'Nothing in the plan can run.');
      onApplied();
      onClose();
    } catch (e) { setError(String(e).replace(/^.*Error:\s*/, '')); setBusy(false); }
  };
  const notes = view ? [['Merged', view.merged], ['Skipped', view.skipped], ['Held back', view.held]] as const : [];
  return (
    <Modal titleId="bulk-plan-title" title="Bulk accept plan" className="bulk-plan" onClose={busy ? undefined : onClose} locked={busy}>
      {/* one scrolling column for the whole plan; the title and the buttons stay in place */}
      <div className="bp-body">
      {!view
        ? <p className="bp-loading" role="status"><i className="run-spin" /> <span className="shimmer">Building your bulk accept plan...</span></p>
        : <>
            <p>{view.run ? `Quorum runs ${view.run} of ${view.total} ${view.total === 1 ? 'item' : 'items'} as one batch, in an order where each step can run. Undo on the batch puts every note back.` : view.groups.some((g) => g.check) ? 'Nothing is ticked yet. Tick the fixes under Check these first to add them to the batch.' : 'Nothing in this plan can run. The reasons are below.'}</p>
            {[view.groups.filter((g) => !g.check), view.groups.filter((g) => g.check)].map((list, at) => list.length > 0 && (
              <section key={at} className="bp-section" aria-labelledby={at ? 'bp-check-title' : undefined}>
                {at === 1 && <h3 id="bp-check-title" className="bp-heading">Check these first</h3>}
                {at === 1 && <p className="bp-sub">These start unticked. Apply leaves them out unless you tick them.</p>}
                <div className="bp-list" role="list">
                  {list.map((g) => {
                    const on = g.items.filter((i) => i.on).length;
                    return (
                      <div key={g.id} className="bp-group" role="listitem">
                        <div className="bp-row">
                          <input type="checkbox" aria-label={g.label} checked={on > 0} ref={(el) => { if (el) el.indeterminate = on > 0 && on < g.items.length; }} onChange={(e) => flip(g.items.map((i) => i.id), e.target.checked)} />
                          <span className="bp-label">{g.label}{g.reason && <span className="bp-reason">{g.reason}</span>}</span>
                          <span className="nf-count" aria-label={`${g.items.length} ${g.items.length === 1 ? 'item' : 'items'}`}>{g.items.length}</span>
                          <button className={`icon-btn conn-fold${open.has(g.id) ? ' open' : ''}`} aria-expanded={open.has(g.id)} aria-label={open.has(g.id) ? `Hide items: ${g.label}` : `Show items: ${g.label}`} onClick={() => fold(g.id)}><IconChevron width={14} height={14} /></button>
                        </div>
                        {open.has(g.id) && (
                          <ul className="bp-items">
                            {g.items.map((i) => (
                              <li key={i.id}>
                                <label><input type="checkbox" checked={i.on} onChange={(e) => flip([i.id], e.target.checked)} /> <span>{i.line}</span></label>
                                {i.notes.length > 0 && <span className="bp-notes" data-tip={i.notes.join(', ')}>{i.notes.length === 1 ? i.notes[0] : `${i.notes.length} notes`}</span>}
                                {i.draft && <DraftEvidence draft={i.draft} compact />}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
            {notes.map(([label, xs]) => xs.length > 0 && (
              <details key={label} className="bp-why">
                <summary>{label} <span className="nf-count">{xs.length}</span></summary>
                <ul>{xs.map((x) => <li key={`${label}${x.id}`}><strong>{x.title}</strong> {x.reason}</li>)}</ul>
              </details>
            ))}
            <label className="bp-save"><input type="checkbox" checked={saveNote} onChange={(e) => setSaveNote(e.target.checked)} /> Save as a note in the Quorum folder</label>
          </>}
      {error && <p className="set-error" role="alert">{error}</p>}
      </div>
      <ModalActions>
        <button className="pill" autoFocus disabled={busy} onClick={onClose}>Cancel</button>
        <button className="pill primary" disabled={busy || !view || (!view.run && !saveNote)} onClick={apply}>{busy ? 'Starting...' : 'Apply'}</button>
      </ModalActions>
    </Modal>
  );
}

// Mark confidential on a note or a folder: one of the values the vault already uses, or a new one
export function ConfidentialMark({ rel, dir, onClose, onDone }: { rel: string; dir: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const [values, setValues] = useState<string[] | null>(null);
  const [pick, setPick] = useState('');
  const [fresh, setFresh] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { window.quorum.confidentialMarks().then((m) => { setValues(m.values); setPick(m.values[0] ?? ''); }).catch(() => setValues([])); }, []);
  const value = (pick === '' ? fresh : pick).trim();
  const save = async () => {
    setBusy(true);
    try { onDone(await window.quorum.confidentialMark(rel, dir, value)); onClose(); } catch (e) { setError(String(e).replace(/^.*Error:\s*/, '')); setBusy(false); }
  };
  const name = rel.split('/').pop()!.replace(/\.md$/i, '');
  return (
    <Modal titleId="conf-mark-title" title={`Mark ${dir ? 'folder' : 'note'} confidential`} onClose={onClose} locked={busy}>
      <p>{dir ? `Every note in ${name} counts as confidential: the agent never reads it, and sync and sharing leave it out. Quorum keeps this mark in its settings and writes nothing into the vault.` : `Quorum adds confidential: to the frontmatter of ${name}. The agent never reads it, and sync and sharing leave it out.`}</p>
      <div className="conf-values" role="radiogroup" aria-label="Value">
        {(values ?? []).map((v) => <label key={v}><input type="radio" name="conf-value" checked={pick === v} onChange={() => setPick(v)} /> {v}</label>)}
        <label><input type="radio" name="conf-value" checked={pick === ''} onChange={() => setPick('')} /> New value</label>
        {pick === '' && <input className="set-field" autoFocus value={fresh} placeholder="For example: personal" maxLength={40} onChange={(e) => setFresh(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && value) save(); }} />}
      </div>
      {error && <p className="set-error" role="alert">{error}</p>}
      <ModalActions>
        <button className="pill" autoFocus disabled={busy} onClick={onClose}>Cancel</button>
        <button className="pill primary" disabled={busy || !value || values === null} onClick={save}>Mark confidential</button>
      </ModalActions>
    </Modal>
  );
}
