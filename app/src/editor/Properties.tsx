import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { draftOf, eolOf, followSave, parseProps, propsProblem, shownValue, storedValue, titleIndex, titleProblem, uniqueKey, writeProps, type Draft, type Prop } from './frontmatter';

// The note's frontmatter as rows of key and value. ⌘↵ or leaving the panel saves, Esc puts back what was saved (and
// wins over the blur that follows it). The title row is edited in the title field above, so it is left out here and
// kept; a title save that rewrites it while you edit other rows is merged into your draft. Frontmatter that does not
// split into rows shows as raw text. error is a save the main process turned down.

export function Properties({ value, readOnly, error, onChange }: { value: string; readOnly: boolean; error?: string | null; onChange: (fm: string) => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(value));
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [focusRow, setFocusRow] = useState<number | null>(null);
  // when Esc was pressed: the blur right after it must not save the draft Esc just threw away
  const cancelled = useRef(0);
  const eol = eolOf(value);
  const dirty = draft.rows ? writeProps(draft.rows, eol) !== draft.base : draft.raw !== draft.base;

  // a new value from a save: an untouched draft follows it; an edited one keeps its edits and takes the new title row
  useEffect(() => { setDraft((d) => followSave(d, value)); }, [value]);

  const hidden = draft.rows ? titleIndex(draft.rows) : -1;
  const shown = (draft.rows ?? []).map((r, i) => ({ r, i })).filter(({ i }) => i !== hidden);
  const check = (rows: Prop[]) => propsProblem(rows) ?? shown.map(({ r }) => titleProblem(r.key)).find(Boolean) ?? null;

  function commit() {
    if (Date.now() - cancelled.current < 400) return;
    if (!dirty) return;
    if (draft.rows) {
      const p = check(draft.rows);
      setProblem(p);
      if (p) return;
    }
    const next = draft.rows ? writeProps(draft.rows, eol) : draft.raw;
    if (next !== value) onChange(next);
  }
  const cancel = () => { cancelled.current = Date.now(); setProblem(null); setDraft(draftOf(value)); };
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); commit(); (e.target as HTMLElement).blur(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); (e.target as HTMLElement).blur(); }
  };
  const setRows = (f: (rows: Prop[]) => Prop[]) => setDraft((d) => ({ ...d, rows: f(d.rows ?? []) }));
  const set = (i: number, patch: Partial<Prop>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () => { const rows = draft.rows ?? []; setFocusRow(rows.length); setRows((rs) => [...rs, { key: uniqueKey(rs), value: '' }]); };
  const parsed = parseProps(value);
  const count = parsed ? parsed.filter((r) => r.key !== 'title').length : 1;
  const shownError = problem ?? error ?? null;

  return (
    <section className={`props ${open ? 'open' : ''}`} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) commit(); }}>
      <button className="props-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Properties <em>{value ? (parsed ? `${count} ${count === 1 ? 'field' : 'fields'}` : 'raw') : 'none'}</em>
      </button>
      {open && shownError && <p className="set-error props-error" role="alert">{shownError}</p>}
      {open && (draft.rows ? (
        <div className="props-rows">
          {shown.map(({ r, i }) => (
            <div key={i} className="props-row">
              <input className="props-key" value={r.key} readOnly={readOnly} aria-label="Property name" autoFocus={focusRow === i} onFocus={() => setFocusRow(null)}
                onKeyDown={keys} onChange={(e) => set(i, { key: e.target.value.replace(/[:\n]/g, '') })} />
              {r.value.includes('\n')
                ? <textarea className="props-val" rows={r.value.split('\n').length} value={shownValue(r.value)} readOnly={readOnly} aria-label={`${r.key} value`} onKeyDown={keys} onChange={(e) => set(i, { value: storedValue(e.target.value) })} />
                : <input className="props-val" value={shownValue(r.value)} readOnly={readOnly} aria-label={`${r.key} value`} onKeyDown={keys} onChange={(e) => set(i, { value: storedValue(e.target.value) })} />}
              {!readOnly && <button className="icon-btn props-del" aria-label={`Remove ${r.key}`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>×</button>}
            </div>
          ))}
          {!readOnly && <button className="pill small-pill props-add" onClick={add}>Add property</button>}
        </div>
      ) : (
        <textarea className="props-raw" value={draft.raw} readOnly={readOnly} aria-label="Frontmatter" rows={Math.max(3, draft.raw.split('\n').length)} onKeyDown={keys} onChange={(e) => setDraft((d) => ({ ...d, raw: e.target.value }))} />
      ))}
    </section>
  );
}
