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
// a heading's text as the note has it, without the words an update removed from it (Markdown.tsx diff)
export const headingText = (h: HTMLElement) => {
  if (!h.querySelector('.md-del')) return h.textContent ?? '';
  const c = h.cloneNode(true) as HTMLElement;
  c.querySelectorAll('.md-del').forEach((x) => x.remove());
  return c.textContent ?? '';
};
export const HEADINGS = 'h1, h2, h3, h4';

// copies a link to a heading and says so for a moment
export function useCopyLink() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (url: string) => navigator.clipboard.writeText(url).then(() => { setCopied(url); window.setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500); }).catch(() => {});
  return { copied, copy };
}

// Over a note's headings: the # in the margin turns into a link button while the pointer is on the # itself, and a
// click copies a link to that heading (quorum://note/<note>#<heading>), so someone can open the note at that step. root
// is the element holding the headings; it must be position: relative. The # sits outside the heading and lets the
// pointer through, so it is found by position. Nothing shows without a link for the note
export function HeadingLinks({ root, base }: { root: RefObject<HTMLElement | null>; base: string | null }) {
  const [at, setAt] = useState<{ top: number; left: number; slug: string } | null>(null);
  const { copied, copy } = useCopyLink();
  useEffect(() => {
    const el = root.current;
    if (!el || !base) return;
    const move = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.('.h-link')) return;
      const b = el.getBoundingClientRect();
      // only the margin strip beside the text, within the note's height, can hold a #
      if (e.clientY < b.top || e.clientY > b.bottom || e.clientX > b.left + 40) { setAt(null); return; }
      const all = [...el.querySelectorAll<HTMLElement>(HEADINGS)];
      for (let i = 0; i < all.length; i++) {
        const r = all[i].getBoundingClientRect();
        // centered on the heading's first line, 24px square, 30px left of the text: the same box as the # and the button
        const line = parseFloat(getComputedStyle(all[i]).lineHeight) || r.height;
        const mid = r.top + Math.min(r.height, line) / 2;
        if (e.clientX >= r.left - 30 && e.clientX <= r.left - 6 && Math.abs(e.clientY - mid) <= 12) {
          const slug = slugsOf(all.map(headingText))[i];
          setAt((cur) => (cur?.slug === slug ? cur : { top: mid - b.top, left: r.left - b.left, slug }));
          return;
        }
      }
      setAt(null);
    };
    const hide = () => setAt(null);
    window.addEventListener('mousemove', move, { passive: true });
    window.addEventListener('scroll', hide, { capture: true, passive: true });
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('scroll', hide, { capture: true }); };
  }, [root, base]);
  if (!base || !at) return null;
  const url = `${base}#${at.slug}`;
  return (
    <button className="h-link" style={{ top: at.top, left: at.left - 30 }} aria-label="Copy a link to this heading" data-tip={copied === url ? 'Link copied' : 'Copy link to this heading'}
      onMouseLeave={() => setAt(null)} onMouseDown={(e) => e.preventDefault()} onClick={() => copy(url)}>
      <IconLink width={14} height={14} />
    </button>
  );
}
