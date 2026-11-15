import { useEffect, useState, type RefObject } from 'react';
import { IconLink } from './icons';

// A heading's anchor in a note link: its text in lowercase words joined by dashes, with -2, -3 for a repeat. The note
// page, the Memory page and the Outline all number headings the same way, top to bottom
const plain = (s: string) => s.replace(/[*_`#[\]]/g, '').trim();
export const headingSlug = (text: string) => plain(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
export function slugsOf(texts: string[]) {
  const seen = new Map<string, number>();
  return texts.map((t) => { const b = headingSlug(t); const n = (seen.get(b) ?? 0) + 1; seen.set(b, n); return n > 1 ? `${b}-${n}` : b; });
}
export const HEADINGS = 'h1, h2, h3, h4';

// copies a link to a heading and says so for a moment
export function useCopyLink() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (url: string) => navigator.clipboard.writeText(url).then(() => { setCopied(url); window.setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500); }).catch(() => {});
  return { copied, copy };
}

// Over a note's headings: the # in the margin turns into a link button on hover, and a click copies a link to that
// heading (quorum://note/<note>#<heading>), so someone can open the note at that step. root is the element holding the
// headings; it must be position: relative. Nothing shows without a link for the note
export function HeadingLinks({ root, base }: { root: RefObject<HTMLElement | null>; base: string | null }) {
  const [at, setAt] = useState<{ top: number; left: number; slug: string } | null>(null);
  const { copied, copy } = useCopyLink();
  useEffect(() => {
    const el = root.current;
    if (!el || !base) return;
    const move = (e: MouseEvent) => {
      const t = e.target as Element;
      if (t.closest('.h-link')) return;
      const h = t.closest<HTMLElement>(HEADINGS);
      if (!h || !el.contains(h)) { setAt(null); return; }
      const all = [...el.querySelectorAll<HTMLElement>(HEADINGS)];
      const slug = slugsOf(all.map((x) => x.textContent ?? ''))[all.indexOf(h)];
      const r = h.getBoundingClientRect(), b = el.getBoundingClientRect();
      // centered on the heading's first line, where the # sits
      const line = parseFloat(getComputedStyle(h).lineHeight) || r.height;
      setAt({ top: r.top - b.top + Math.min(r.height, line) / 2, left: r.left - b.left, slug });
    };
    const leave = (e: MouseEvent) => { if (!(e.relatedTarget as Element | null)?.closest?.('.h-link')) setAt(null); };
    el.addEventListener('mousemove', move);
    el.addEventListener('mouseleave', leave);
    return () => { el.removeEventListener('mousemove', move); el.removeEventListener('mouseleave', leave); };
  }, [root, base]);
  if (!base || !at) return null;
  const url = `${base}#${at.slug}`;
  return (
    <button className="h-link" style={{ top: at.top, left: at.left - 30 }} aria-label="Copy a link to this heading" data-tip={copied === url ? 'Link copied' : 'Copy link to this heading'}
      onMouseLeave={(e) => { if (!(e.relatedTarget as Element | null)?.closest?.(HEADINGS)) setAt(null); }}
      onMouseDown={(e) => e.preventDefault()} onClick={() => copy(url)}>
      <IconLink width={14} height={14} />
    </button>
  );
}
