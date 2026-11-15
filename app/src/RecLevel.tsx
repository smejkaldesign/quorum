import { useEffect, useId, useRef } from 'react';

// The Record button while recording: a green ring that fills from the bottom with the voice it hears. The level comes
// from the helper's meter (onLevel, 0 to 1) and is drawn straight onto the shape, so speech never re-renders React.
export function RecLevel({ live }: { live: boolean }) {
  const fill = useRef<SVGRectElement>(null);
  const clip = `rec-level-${useId().replace(/:/g, '')}`;
  useEffect(() => {
    const r = fill.current;
    if (!r) return;
    const draw = (v: number) => { const h = 15 * Math.min(1, v); r.setAttribute('y', String(17.5 - h)); r.setAttribute('height', String(h)); };
    if (!live) { draw(0); return; }
    let level = 0;
    const off = window.quorum.onLevel((v) => { level = level * 0.55 + Math.min(1, v * 1.6) * 0.45; draw(level); });
    return () => { off(); draw(0); };
  }, [live]);
  return (
    <svg className="rec-level" width="17" height="17" viewBox="0 0 20 20" aria-hidden="true">
      <defs><clipPath id={clip}><circle cx="10" cy="10" r="7.5" /></clipPath></defs>
      <rect ref={fill} className="rec-level-fill" x="0" y="17.5" width="20" height="0" clipPath={`url(#${clip})`} />
      <circle cx="10" cy="10" r="8.25" fill="none" className="rec-level-ring" strokeWidth="1.6" />
    </svg>
  );
}
