import { createContext, useContext, type ReactNode } from 'react';

// in the Memory view, note links open inside Quorum instead of in another app
const WikiOpen = createContext<((target: string) => void) | null>(null);

// just enough Markdown for agent answers: paragraphs, nested bullets, **bold**, `code`, [links](url).
// builds React nodes (never innerHTML), so model output can't inject markup
export function Markdown({ text, root, headings, onWiki }: { text: string; root?: string; headings?: boolean; onWiki?: (target: string) => void }) {
  const blocks: ReactNode[] = [];
  let list: { depth: number; text: string }[] = [];
  const flush = () => {
    if (list.length) blocks.push(<BulletList key={blocks.length} items={list} root={root} />);
    list = [];
  };
  for (const line of text.split('\n')) {
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) { list.push({ depth: Math.floor(bullet[1].length / 2), text: bullet[2] }); continue; }
    flush();
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h && headings) blocks.push(<h2 key={blocks.length} className="md-h"><span className="hash">#</span>{inline(h[1], root)}</h2>);
    else if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line.replace(/^#+\s*/, ''), root)}</p>);
  }
  flush();
  return <WikiOpen.Provider value={onWiki ?? null}><div className="md">{blocks}</div></WikiOpen.Provider>;
}

function BulletList({ items, root }: { items: { depth: number; text: string }[]; root?: string }) {
  return (
    <ul>
      {items.map((it, i) => <li key={i} style={{ marginLeft: it.depth * 18 }} className={it.depth ? 'sub' : ''}>{inline(it.text.replace(/^\[ \]\s*/, '☐ ').replace(/^\[x\]\s*/i, '☑ '), root)}</li>)}
    </ul>
  );
}

function inline(text: string, root?: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|!?\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={m.index}>{m[1]}</strong>);
    else if (m[2]) out.push(<code key={m.index}>{m[2]}</code>);
    else if (m[5]) out.push(<WikiLink key={m.index} target={m[5]} label={m[6] ?? m[5].replace(/#.*$/, '')} />);
    else out.push(<Link key={m.index} label={m[3]} href={m[4]} root={root} />);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function WikiLink({ target, label }: { target: string; label: string }) {
  const onWiki = useContext(WikiOpen);
  if (!onWiki) return <span className="md-wiki">{label}</span>;
  return <button className="md-link" onClick={() => onWiki(target.replace(/#.*$/, ''))}>{label}</button>;
}

// web links open in the browser; note links open in Quorum's Memory view when it's showing, else the user's knowledge app
function Link({ label, href, root }: { label: string; href: string; root?: string }) {
  const onWiki = useContext(WikiOpen);
  const open = () => {
    if (/^https:\/\//.test(href)) window.quorum.openExternal(href);
    else if (href.endsWith('.md') && onWiki) { try { onWiki(decodeURIComponent(href)); } catch { onWiki(href); } }
    else if (href.endsWith('.md') && root) window.quorum.openNote(href.startsWith('/') ? href : `${root}/${href}`);
  };
  return <button className="md-link" onClick={open}>{label}</button>;
}
