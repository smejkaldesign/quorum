import { useEffect, useState } from 'react';
import type { MissingLink } from './quorum';
import { IconClose } from './icons';

// Links that point at a note that doesn't exist. Some are typos or renamed notes (fix them), some are notes worth
// writing (create them), and some are fine as they are (leave them). Nothing changes without a click.
export const LEFT_KEY = 'quorum.linksLeft';
export const leftAsIs = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(LEFT_KEY) ?? '[]')); } catch { return new Set(); } };

// the TL;DR: what's wrong in plain words, and the likely fix
function summary(m: MissingLink) {
  const who = m.count === 1 ? 'One note links to' : `${m.count} notes link to`;
  const name = `“${m.target}”`;
  if (/^(\.\.\/|\/)|(^|\/)\.claude\//.test(m.target)) return `${who} ${name}, which lives outside this vault, so Quorum can't follow it. Leave it if that's on purpose, or point it at a note inside the vault.`;
  const c = m.candidates[0];
  if (c?.exact) return `${who} ${name}, but no note goes by that name. It's almost certainly “${c.name ?? c.title}”: adding ${name} as one of its aliases fixes every link at once.`;
  if (c) return `${who} ${name}, but no note has that name. “${c.name ?? c.title}” has a similar name and might be what was meant.`;
  return `${who} ${name}, but nothing in the vault matches. Write the note if it's worth having, or leave the link as a placeholder.`;
}

export function LinkHealth({ focus, onOpen, onCreate, onClose, onChanged }: {
  focus: string | null; onOpen: (rel: string) => void; onCreate: (name: string) => void; onClose: () => void; onChanged: () => void;
}) {
  const [items, setItems] = useState<MissingLink[] | null>(null);
  const [left, setLeft] = useState<Set<string>>(leftAsIs);
  const [done, setDone] = useState('');
  const load = () => window.quorum.vaultLinkHealth().then(setItems);
  useEffect(() => { load(); }, []);
  useEffect(() => window.quorum.onVaultChanged(() => { load(); }), []);
  useEffect(() => { if (focus) document.getElementById(`lh-${focus.toLowerCase()}`)?.scrollIntoView({ block: 'center' }); }, [focus, items]);

  const leave = (t: string) => setLeft((s) => {
    const n = new Set(s);
    if (n.has(t)) n.delete(t); else n.add(t);
    try { localStorage.setItem(LEFT_KEY, JSON.stringify([...n])); } catch {}
    setTimeout(onChanged, 0);
    return n;
  });
  const alias = async (m: MissingLink, rel: string) => {
    await window.quorum.vaultAddAlias(rel, m.target);
    setDone(`Added “${m.target}” as an alias, so ${m.count} ${m.count === 1 ? 'link now works' : 'links now work'}`);
    load();
    onChanged();
  };
  const fix = async (m: MissingLink, rel: string) => {
    const r = await window.quorum.vaultFixLink(m.target, rel);
    setDone(`Fixed ${r.links} ${r.links === 1 ? 'link' : 'links'} in ${r.files} ${r.files === 1 ? 'note' : 'notes'}`);
    load();
    onChanged();
  };

  const open = (items ?? []).filter((m) => !left.has(m.target.toLowerCase()));
  const kept = (items ?? []).filter((m) => left.has(m.target.toLowerCase()));
  const fixable = open.filter((m) => m.candidates.length).length;

  const row = (m: MissingLink, isLeft: boolean) => (
    <div key={m.target} id={`lh-${m.target.toLowerCase()}`} className={`lh-item ${focus?.toLowerCase() === m.target.toLowerCase() ? 'focus' : ''}`}>
      <div className="lh-top">
        <strong>[[{m.target}]]</strong>
        <span>{m.count} {m.count === 1 ? 'note links' : 'notes link'} here</span>
      </div>
      <p className="lh-tldr">{summary(m)}</p>
      <div className="lh-from">{m.sources.slice(0, 3).map((s) => <button key={s} onClick={() => onOpen(s)}>{s.split('/').pop()!.replace(/\.md$/, '')}</button>)}{m.sources.length > 3 && <em>+{m.sources.length - 3} more</em>}</div>
      {!isLeft && m.candidates.length > 0 && (
        <div className="lh-fixes">
          {m.candidates.slice(0, 2).map((c, i) => (
            <span key={c.rel} className="lh-fix">
              <button className={`pill small-pill ${i === 0 ? 'primary' : ''}`} onClick={() => alias(m, c.rel)} data-tip={`Adds “${m.target}” to the aliases of ${c.rel}`}>Add as alias of {c.name ?? c.title}</button>
              <button className="lh-alt" onClick={() => fix(m, c.rel)} data-tip={`Rewrites the ${m.count} ${m.count === 1 ? 'link' : 'links'} instead`}>or relink</button>
            </span>
          ))}
        </div>
      )}
      <div className="lh-actions">
        {!isLeft && <button onClick={() => onCreate(m.target.split('/').pop()!)}>Create note</button>}
        <button onClick={() => leave(m.target.toLowerCase())}>{isLeft ? 'Move back to review' : 'Leave as is'}</button>
      </div>
    </div>
  );

  return (
    <div className="link-health" role="region" aria-label="Link health">
      <div className="lh-head">
        <h2>Link health</h2>
        <button className="icon-btn" aria-label="Close link health" data-tip="Back to graph" onClick={onClose}><IconClose width={16} height={16} /></button>
      </div>
      <p className="lh-sum">
        {items === null ? 'Checking links…' : open.length === 0 ? 'Every link points at a note.' : `${open.length} missing ${open.length === 1 ? 'note' : 'notes'}${fixable ? ` · ${fixable} with a likely match` : ''}`}
        {done && <span className="lh-done">{done}</span>}
      </p>
      <div className="lh-list">
        {open.map((m) => row(m, false))}
        {kept.length > 0 && <h5>Left as is ({kept.length})</h5>}
        {kept.map((m) => row(m, true))}
      </div>
    </div>
  );
}
