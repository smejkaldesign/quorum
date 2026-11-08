// One tooltip layer for every [data-tip]: waits half a second, fades in and out, and points back at
// what it came from. data-tip-pos picks a side (bottom by default); it flips when there's no room.
type Side = 'top' | 'bottom' | 'left' | 'right';
const DELAY = 500;
const GAP = 10;
const EDGE = 8;

export function installTooltips() {
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);

  let anchor: HTMLElement | null = null;
  let timer = 0;

  const place = (el: HTMLElement) => {
    tip.textContent = el.dataset.tip ?? '';
    const a = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const want = (el.dataset.tipPos as Side) || 'bottom';
    const room: Record<Side, boolean> = {
      bottom: a.bottom + GAP + t.height < innerHeight - EDGE,
      top: a.top - GAP - t.height > EDGE,
      right: a.right + GAP + t.width < innerWidth - EDGE,
      left: a.left - GAP - t.width > EDGE,
    };
    const flip: Record<Side, Side> = { bottom: 'top', top: 'bottom', left: 'right', right: 'left' };
    const side = room[want] || !room[flip[want]] ? want : flip[want];
    const clamp = (v: number, max: number) => Math.max(EDGE, Math.min(v, max - EDGE));
    let x: number, y: number;
    if (side === 'top' || side === 'bottom') {
      x = clamp(a.left + a.width / 2 - t.width / 2, innerWidth - t.width);
      y = side === 'bottom' ? a.bottom + GAP : a.top - GAP - t.height;
      tip.style.setProperty('--arrow', `${a.left + a.width / 2 - x}px`);
    } else {
      x = side === 'right' ? a.right + GAP : a.left - GAP - t.width;
      y = clamp(a.top + a.height / 2 - t.height / 2, innerHeight - t.height);
      tip.style.setProperty('--arrow', `${a.top + a.height / 2 - y}px`);
    }
    tip.dataset.side = side;
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };

  const show = (el: HTMLElement) => {
    if (!el.isConnected || !el.dataset.tip) return;
    place(el);
    tip.classList.add('on');
  };
  const hide = () => {
    clearTimeout(timer);
    anchor = null;
    tip.classList.remove('on');
  };
  const enter = (el: HTMLElement | null) => {
    if (el === anchor) return;
    hide();
    if (!el) return;
    anchor = el;
    timer = window.setTimeout(() => show(el), DELAY);
  };

  document.addEventListener('pointerover', (e) => enter((e.target as Element).closest?.('[data-tip]') as HTMLElement | null));
  document.documentElement.addEventListener('pointerleave', hide);
  document.addEventListener('focusin', (e) => { const el = (e.target as Element).closest?.('[data-tip]') as HTMLElement | null; if (el?.matches(':focus-visible')) enter(el); });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('wheel', hide, { passive: true, capture: true });
}
