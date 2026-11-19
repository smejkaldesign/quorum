import { useEffect, useState, type RefObject } from 'react';
import { Markdown } from '../Markdown';

const HOVER_MS = 450;
const WIDTH = 380;
// a wiki link in the editor or the read view, or a markdown link to a .md note
const LINK = '[data-wiki], [data-href$=".md"], a[href$=".md"]';

// Hovering a link to a note for a moment shows the start of that note beside it. from is the note the link is in, which
// a relative link resolves against. The preview closes when the pointer leaves the link or the area, on a click, and on
// scroll
export function LinkPreview({ root, from }: { root: RefObject<HTMLElement | null>; from: string }) {
  const [shown, setShown] = useState<{ x: number; y: number; above: boolean; title: string; body: string } | null>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let timer = 0;
    let over: HTMLElement | null = null;
    let token = 0;
    const close = () => { window.clearTimeout(timer); token++; over = null; setShown(null); };
    const onOver = (e: MouseEvent) => {
      const link = (e.target as HTMLElement).closest<HTMLElement>(LINK);
      if (link === over) return;
      close();
      if (!link) return;
      over = link;
      const id = token;
      timer = window.setTimeout(async () => {
        let target = (link.dataset.wiki ?? link.dataset.href ?? link.getAttribute('href') ?? '').replace(/#.*$/, '');
        try { target = decodeURIComponent(target); } catch { /* kept as written */ }
        const rel = target ? await window.quorum.vaultResolve(target, from).catch(() => null) : null;
        const n = rel ? await window.quorum.vaultPeek(rel).catch(() => null) : null;
        if (id !== token || !n) return;
        const r = link.getBoundingClientRect();
        const above = r.bottom + 260 > window.innerHeight;
        setShown({ x: Math.max(8, Math.min(r.left, window.innerWidth - WIDTH - 8)), y: above ? r.top - 6 : r.bottom + 6, above, title: n.title, body: n.body.slice(0, 1500) });
      }, HOVER_MS);
    };
    const onLeave = () => close();
    el.addEventListener('mouseover', onOver);
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    return () => {
      close();
      el.removeEventListener('mouseover', onOver);
      el.removeEventListener('mouseleave', onLeave);
      el.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [root, from]);
  if (!shown) return null;
  return (
    <div className={`link-preview ${shown.above ? 'above' : ''}`} role="tooltip" style={{ left: shown.x, top: shown.y, width: WIDTH }}>
      <h4>{shown.title}</h4>
      {shown.body.trim() ? <Markdown text={shown.body} /> : <p className="muted">This note is empty.</p>}
    </div>
  );
}
