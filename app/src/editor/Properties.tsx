import { useEffect, useState, type KeyboardEvent } from 'react';
import { parseProps, shownValue, storedValue, writeProps, type Prop } from './frontmatter';

// The note's frontmatter as rows of key and value. ⌘↵ or leaving the panel saves, Esc puts back what was saved.
// The title row is edited in the title field above, so it is left out here and kept as it is. Frontmatter that does not
// split into rows shows as raw text, edited the same way.
export function Properties({ value, readOnly, onChange }: { value: string; readOnly: boolean; onChange: (fm: string) => void }) {
  const parsed = parseProps(value);
  const [rows, setRows] = useState<Prop[] | null>(parsed);
  const [raw, setRaw] = useState(value);
  const [open, setOpen] = useState(false);
  // a save from elsewhere (the title, a reload) resets the draft
  useEffect(() => { setRows(parseProps(value)); setRaw(value); }, [value]);
  const shown = (rows ?? []).map((r, i) => ({ r, i })).filter(({ r }) => r.key !== 'title');
  const commit = () => {
    const next = rows ? writeProps(rows) : raw;
    if (next !== value) onChange(next);
  };
  const cancel = () => { setRows(parseProps(value)); setRaw(value); };
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); commit(); (e.target as HTMLElement).blur(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); (e.target as HTMLElement).blur(); }
  };
  const set = (i: number, patch: Partial<Prop>) => setRows((rs) => (rs ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const count = parsed ? shown.length : 1;

  return (
    <section className={`props ${open ? 'open' : ''}`} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) commit(); }}>
      <button className="props-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Properties <em>{value ? (parsed ? `${count} ${count === 1 ? 'field' : 'fields'}` : 'raw') : 'none'}</em>
      </button>
      {open && (rows ? (
        <div className="props-rows">
          {shown.map(({ r, i }) => (
            <div key={i} className="props-row">
              <input className="props-key" value={r.key} readOnly={readOnly} aria-label="Property name" onKeyDown={keys} onChange={(e) => set(i, { key: e.target.value.replace(/[:\n]/g, '') })} />
              {r.value.includes('\n')
                ? <textarea className="props-val" rows={r.value.split('\n').length} value={shownValue(r.value)} readOnly={readOnly} aria-label={`${r.key} value`} onKeyDown={keys} onChange={(e) => set(i, { value: storedValue(e.target.value) })} />
                : <input className="props-val" value={shownValue(r.value)} readOnly={readOnly} aria-label={`${r.key} value`} onKeyDown={keys} onChange={(e) => set(i, { value: storedValue(e.target.value) })} />}
              {!readOnly && <button className="icon-btn props-del" aria-label={`Remove ${r.key}`} onClick={() => setRows((rs) => (rs ?? []).filter((_, j) => j !== i))}>×</button>}
            </div>
          ))}
          {!readOnly && <button className="pill small-pill props-add" onClick={() => setRows((rs) => [...(rs ?? []), { key: 'key', value: '' }])}>Add property</button>}
        </div>
      ) : (
        <textarea className="props-raw" value={raw} readOnly={readOnly} aria-label="Frontmatter" rows={Math.max(3, raw.split('\n').length)} onKeyDown={keys} onChange={(e) => setRaw(e.target.value)} />
      ))}
    </section>
  );
}
