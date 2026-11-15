import { useEffect, useRef, useState } from 'react';

// A page's top row (Back and its actions) pins to the top of the scroll area once it scrolls past: put the sentinel just
// above the row and give the row `sticky-bar` plus `stuck` while this says so
export function useStuck() {
  const sentinel = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const box = el.closest<HTMLElement>('.end-scroll, .body');
    if (!box) return;
    // stuck once the sentinel has scrolled above the top of the scroll area
    const check = () => setStuck(el.getBoundingClientRect().top < box.getBoundingClientRect().top);
    check();
    box.addEventListener('scroll', check, { passive: true });
    return () => box.removeEventListener('scroll', check);
  }, []);
  return { sentinel, stuck };
}

// the page title typed out beside Back once the pinned row has slid in; cleared when the row unpins
export function TypedTitle({ text, on }: { text: string; on: boolean }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) { setN(0); return; }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setN(text.length); return; }
    // one character at a time, the whole title in about 0.7 seconds at most, starting once the row has slid in
    const step = Math.max(12, Math.min(28, 700 / Math.max(1, text.length)));
    let timer = 0;
    const wait = window.setTimeout(() => {
      timer = window.setInterval(() => setN((k) => { if (k + 1 >= text.length) window.clearInterval(timer); return Math.min(text.length, k + 1); }), step);
    }, 260);
    return () => { window.clearTimeout(wait); window.clearInterval(timer); };
  }, [on, text]);
  return <span className="rb-title" aria-hidden={!on}>{text.slice(0, n)}</span>;
}

// The note editor's toolbar docks under the pinned Back bar once it reaches it: the page gets tb-docked, the toolbar
// drops its outline and the line under the header moves below it. --bar-h is the pinned bar's height, the toolbar's
// sticky offset
export function useToolbarDock(sentinel: React.RefObject<HTMLDivElement | null>, stuck: boolean) {
  useEffect(() => {
    const el = sentinel.current;
    const page = el?.parentElement;
    const box = el?.closest<HTMLElement>('.end-scroll, .body');
    if (!page || !box) return;
    const check = () => {
      const bar = page.querySelector<HTMLElement>('.sticky-bar');
      const tb = page.querySelector<HTMLElement>('.note-toolbar');
      if (bar) page.style.setProperty('--bar-h', `${bar.offsetHeight}px`);
      const docked = !!(bar?.classList.contains('stuck') && tb && tb.getBoundingClientRect().top <= bar.getBoundingClientRect().bottom + 1);
      page.classList.toggle('tb-docked', docked);
    };
    // the bar's pinned layout lands a frame after the state flips
    // and its slide-in moves its bottom edge for 240 ms, so look again once that settles
    const frame = requestAnimationFrame(check);
    const settle = window.setTimeout(check, 300);
    box.addEventListener('scroll', check, { passive: true });
    return () => { cancelAnimationFrame(frame); window.clearTimeout(settle); box.removeEventListener('scroll', check); page.classList.remove('tb-docked'); };
  }, [sentinel, stuck]);
}

// a tab picked from the pinned bar opens at the top of the page; the smooth scroll lets the bar slide away
export function toPageTop(sentinel: React.RefObject<HTMLDivElement | null>) {
  sentinel.current?.closest<HTMLElement>('.end-scroll, .body')?.scrollTo({ top: 0, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
