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
