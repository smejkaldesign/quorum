import { useEffect, useRef } from 'react';
import { ForceSim, type GraphSettings, type SimNode } from './forceSim';

export type GraphView = GraphSettings & { lineSizeMultiplier: number; textFadeMultiplier: number; showOrphans: boolean; showUnresolved: boolean };
export type GraphData = {
  nodes: { id: string; name: string; deg: number; color: string | null; t: number; ghost?: boolean }[];
  links: [number, number][];
  settings: GraphView;
  groups: { query: string; color: string }[];
};

type Node = SimNode & { id: string; name: string; color: string; t: number };
type Api = { configure: (v: GraphView) => void; timelapse: () => void; stop: () => void; refit: () => void };

const DEFAULT_NODE = '#8f8f8f';
// a link to a note that doesn't exist yet: dimmer and smaller, like Obsidian's unresolved nodes
const GHOST_NODE = '#4d4d52';
const LINE = 'rgba(255, 255, 255, 0.09)';
const ACCENT = '#82a9ff';
// where notes last sat, so a refresh after an edit keeps the layout instead of starting over
const placed = new Map<string, { x: number; y: number }>();
let lastCam: { k: number; x: number; y: number; moved: boolean } | null = null;

const radius = (deg: number, v: GraphView) => (1.8 + Math.sqrt(deg) * 1.0) * v.nodeSizeMultiplier;

// Obsidian-style graph on a 2D canvas: one batched path for links, nodes batched by color
export function Graph({ data, view, query, focus, timelapse, onOpen, onTimelapseEnd }: {
  data: GraphData; view: GraphView; query: string; focus?: string | null; timelapse: number; onOpen: (id: string) => void; onTimelapseEnd: () => void;
}) {
  const focusRef = useRef(focus ?? null);
  focusRef.current = focus ?? null;
  const canvas = useRef<HTMLCanvasElement>(null);
  const queryRef = useRef(query);
  queryRef.current = query;
  const viewRef = useRef(view);
  viewRef.current = view;
  const endRef = useRef(onTimelapseEnd);
  endRef.current = onTimelapseEnd;
  const kick = useRef<() => void>(() => {});
  const api = useRef<Api | null>(null);

  useEffect(() => { kick.current(); }, [query]);
  useEffect(() => { api.current?.refit(); }, [focus]);
  useEffect(() => { api.current?.configure(view); }, [view]);
  useEffect(() => { if (timelapse) api.current?.timelapse(); else api.current?.stop(); }, [timelapse]);

  useEffect(() => {
    const el = canvas.current!;
    const ctx = el.getContext('2d')!;
    const v0 = viewRef.current;
    const keep = data.nodes.map((n, i) => ((n.ghost && !v0.showUnresolved) || (!n.ghost && !n.deg && !v0.showOrphans) ? -1 : i)).filter((i) => i >= 0);
    const remap = new Map(keep.map((old, i) => [old, i]));
    const nodes: Node[] = keep.map((i) => {
      const n = data.nodes[i];
      return { ...n, color: n.ghost ? GHOST_NODE : n.color ?? DEFAULT_NODE, x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null, r: radius(n.deg, v0) };
    });
    const links = data.links.filter(([a, b]) => remap.has(a) && remap.has(b)).map(([a, b]) => [remap.get(a)!, remap.get(b)!] as [number, number]);
    const neighbors = nodes.map(() => new Set<number>());
    for (const [a, b] of links) { neighbors[a].add(b); neighbors[b].add(a); }
    const sim = new ForceSim(nodes, links, v0);
    const on = sim.on;
    let known = 0;
    for (const n of nodes) { const p = placed.get(n.id); if (p) { n.x = p.x; n.y = p.y; known++; } }
    const warm = known > nodes.length / 2;
    if (warm) sim.alpha = 0.12;

    const cam = { k: 0.35, x: 0, y: 0 };
    let w = 0, h = 0, dpr = 1;
    let hover = -1;
    let userMoved = false;
    let raf = 0;
    let dirty = true;
    // timelapse: notes in the order they were written, switched on a few per frame
    let lapse: { order: number[]; next: number; start: number; dur: number } | null = null;
    // where each note sits in the settled layout; the timelapse glides notes there so it ends on the same graph
    let home: { x: number; y: number }[] | null = null;

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      w = el.clientWidth; h = el.clientHeight;
      el.width = Math.round(w * dpr); el.height = Math.round(h * dpr);
      dirty = true;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const toWorld = (sx: number, sy: number) => ({ x: (sx - w / 2 - cam.x) / cam.k, y: (sy - h / 2 - cam.y) / cam.k });

    let focusId: string | null = null, focusAt = -1;
    const focused = () => {
      if (focusRef.current !== focusId) { focusId = focusRef.current; focusAt = focusId ? nodes.findIndex((n) => n.id === focusId) : -1; }
      return focusAt >= 0 && on[focusAt] ? focusAt : -1;
    };

    // switching focus glides the camera instead of jumping, so it reads as one canvas zooming in and out
    let glide: { k: number; x: number; y: number } | null = null;
    const fit = (animate = false) => {
      const to = frame();
      if (animate || glide) glide = to; else { cam.k = to.k; cam.x = to.x; cam.y = to.y; }
    };

    // keep the whole graph in view until the user pans or zooms; a focused note frames itself and its links instead
    const frame = () => {
      const f = focused();
      if (f >= 0) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const i of [f, ...neighbors[f]]) {
          if (!on[i]) continue;
          const n = nodes[i];
          x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r); x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r);
        }
        const k = Math.min(3, w / (Math.max(x1 - x0, 80) * 1.4), h / (Math.max(y1 - y0, 80) * 1.4));
        return { k, x: -((x0 + x1) / 2) * k, y: -((y0 + y1) / 2) * k };
      }
      let r = 40;
      nodes.forEach((n, i) => { if (on[i]) r = Math.max(r, Math.hypot(n.x, n.y) + n.r); });
      return { k: Math.min(w, h) / (2 * r * 1.06), x: 0, y: 0 };
    };
    const glideStep = () => {
      if (!glide) return false;
      // ease in log space for zoom so zooming out and in feel the same speed
      const t = 0.14;
      cam.k = Math.exp(Math.log(cam.k) + (Math.log(glide.k) - Math.log(cam.k)) * t);
      cam.x += (glide.x - cam.x) * t; cam.y += (glide.y - cam.y) * t;
      if (Math.abs(Math.log(glide.k / cam.k)) < 0.002 && Math.abs(glide.x - cam.x) + Math.abs(glide.y - cam.y) < 0.5) { cam.k = glide.k; cam.x = glide.x; cam.y = glide.y; glide = null; }
      return true;
    };

    const draw = () => {
      const v = viewRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(w / 2 + cam.x, h / 2 + cam.y);
      ctx.scale(cam.k, cam.k);

      const q = queryRef.current.trim().toLowerCase();
      const match = q ? new Set(nodes.map((n, i) => (n.name.toLowerCase().includes(q) ? i : -1)).filter((i) => i >= 0)) : null;
      const hl = hover >= 0 ? hover : focused();
      const lit = hl >= 0 ? new Set([hl, ...neighbors[hl]]) : match;
      const dimmed = (i: number) => lit !== null && !lit.has(i);

      // labels go down first so lines and dots draw over them; they fade in with zoom like Obsidian,
      // and the hovered note and its neighbors always get one, kept quiet so the graph stays readable
      const fade = Math.max(0, Math.min(1, (cam.k * 2.4 - 7 + v.textFadeMultiplier * 2) / 4));
      ctx.font = `${11 / cam.k}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#a1a1a6';
      nodes.forEach((n, i) => {
        if (!on[i]) return;
        const forced = lit?.has(i) && (hl >= 0 || (match && match.size < 40));
        const a = i === hl ? 0.85 : forced ? 0.5 : dimmed(i) ? 0 : fade * 0.7;
        if (a < 0.05) return;
        ctx.globalAlpha = a;
        ctx.fillText(n.name.length > 42 ? `${n.name.slice(0, 40)}…` : n.name, n.x, n.y + n.r + 3 / cam.k);
      });

      ctx.lineWidth = (0.7 * v.lineSizeMultiplier) / cam.k;
      ctx.strokeStyle = LINE;
      ctx.globalAlpha = lit ? 0.35 : 1;
      ctx.beginPath();
      for (const [a, b] of links) { if (on[a] && on[b]) { ctx.moveTo(nodes[a].x, nodes[a].y); ctx.lineTo(nodes[b].x, nodes[b].y); } }
      ctx.stroke();
      if (hl >= 0) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = (1.2 * v.lineSizeMultiplier) / cam.k;
        ctx.beginPath();
        for (const nb of neighbors[hl]) { if (on[nb]) { ctx.moveTo(nodes[hl].x, nodes[hl].y); ctx.lineTo(nodes[nb].x, nodes[nb].y); } }
        ctx.stroke();
      }

      const byColor = new Map<string, number[]>();
      nodes.forEach((n, i) => { if (!on[i]) return; const key = `${n.color}|${dimmed(i) ? 1 : 0}`; (byColor.get(key) ?? byColor.set(key, []).get(key)!).push(i); });
      for (const [key, idx] of byColor) {
        const [color, dim] = key.split('|');
        ctx.globalAlpha = dim === '1' ? 0.18 : 1;
        ctx.fillStyle = color;
        ctx.beginPath();
        for (const i of idx) { const n = nodes[i]; ctx.moveTo(n.x + n.r, n.y); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); }
        ctx.fill();
      }
      if (hl >= 0) {
        const n = nodes[hl];
        ctx.globalAlpha = 1;
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 2 / cam.k;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 2 / cam.k, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();

      // the date the timelapse has reached, bottom left
      if (lapse && lapse.next > 0) {
        const t = nodes[lapse.order[lapse.next - 1]].t;
        ctx.globalAlpha = 0.75;
        ctx.fillStyle = '#c8c8cc';
        ctx.font = '500 13px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '', 16, h - 14);
      }
      ctx.globalAlpha = 1;
    };

    // drop each new note beside a note it links to that's already there, or near the middle
    const reveal = (i: number) => {
      const nb = [...neighbors[i]].find((j) => on[j]);
      const a = Math.random() * Math.PI * 2;
      const base = nb !== undefined ? nodes[nb] : { x: 0, y: 0 };
      const d = nb !== undefined ? 8 : 30 * Math.random();
      nodes[i].x = base.x + Math.cos(a) * d; nodes[i].y = base.y + Math.sin(a) * d;
      nodes[i].vx = nodes[i].vy = 0;
      on[i] = 1;
    };

    const loop = (now: number) => {
      if (lapse) {
        const want = Math.min(lapse.order.length, Math.ceil(((now - lapse.start) / lapse.dur) * lapse.order.length));
        while (lapse.next < want) reveal(lapse.order[lapse.next++]);
        if (lapse.next >= lapse.order.length) { lapse = null; endRef.current(); }
      }
      if (home) {
        let moving = false;
        nodes.forEach((n, i) => {
          if (!on[i]) return;
          const dx = home![i].x - n.x, dy = home![i].y - n.y;
          if (Math.abs(dx) + Math.abs(dy) > 0.2) { n.x += dx * 0.12; n.y += dy * 0.12; moving = true; } else { n.x = home![i].x; n.y = home![i].y; }
        });
        if (!lapse && !moving) home = null;
        if (!userMoved) fit();
        dirty = true;
      } else if (sim.active) {
        sim.tick();
        if (!userMoved) fit();
        dirty = true;
      }
      if (glideStep()) dirty = true;
      if (dirty) { draw(); dirty = false; }
      raf = requestAnimationFrame(loop);
    };
    // settle a little before the first paint so it doesn't open as a hairball
    if (!warm) for (let i = 0; i < 60; i++) sim.tick();
    if (focused() >= 0) { const f = focusRef.current; focusRef.current = null; focusId = null; focusAt = -1; fit(); focusRef.current = f; fit(true); } else fit();
    if (warm && lastCam?.moved && focused() < 0) { cam.k = lastCam.k; cam.x = lastCam.x; cam.y = lastCam.y; userMoved = true; }
    raf = requestAnimationFrame(loop);
    kick.current = () => { dirty = true; };

    api.current = {
      configure: (v) => {
        sim.configure(v);
        nodes.forEach((n) => { n.r = radius(n.deg, v); });
        sim.reheat(0.3);
        dirty = true;
      },
      timelapse: () => {
        const order = nodes.map((_, i) => i).sort((a, b) => nodes[a].t - nodes[b].t);
        // let the layout finish settling first so the end state is the graph you were looking at
        if (!home) { for (let k = 0; k < 400 && sim.active; k++) sim.tick(); home = nodes.map((n) => ({ x: n.x, y: n.y })); }
        sim.alpha = 0;
        on.fill(0);
        userMoved = false;
        lapse = { order, next: 0, start: performance.now(), dur: Math.max(5000, Math.min(16000, order.length * 9)) };
        dirty = true;
      },
      refit: () => { userMoved = false; fit(true); dirty = true; },
      stop: () => {
        if (!lapse) return;
        while (lapse.next < lapse.order.length) reveal(lapse.order[lapse.next++]);
        lapse = null;
        dirty = true;
      },
    };

    const nodeAt = (sx: number, sy: number) => {
      const p = toWorld(sx, sy);
      let best = -1, bestD = Infinity;
      nodes.forEach((n, i) => {
        if (!on[i]) return;
        const d = Math.hypot(n.x - p.x, n.y - p.y);
        if (d < n.r + 4 / cam.k && d < bestD) { best = i; bestD = d; }
      });
      return best;
    };

    let drag: { node: number; sx: number; sy: number; moved: boolean; vx: number; vy: number } | null = null;
    const pos = (e: MouseEvent) => { const b = el.getBoundingClientRect(); return { sx: e.clientX - b.left, sy: e.clientY - b.top }; };

    const onDown = (e: MouseEvent) => {
      const { sx, sy } = pos(e);
      drag = { node: nodeAt(sx, sy), sx, sy, moved: false, vx: cam.x, vy: cam.y };
    };
    const onMove = (e: MouseEvent) => {
      const { sx, sy } = pos(e);
      if (drag) {
        if (Math.hypot(sx - drag.sx, sy - drag.sy) > 3) drag.moved = true;
        if (!drag.moved) return;
        userMoved = true;
        glide = null;
        if (drag.node >= 0) {
          const p = toWorld(sx, sy);
          nodes[drag.node].fx = p.x; nodes[drag.node].fy = p.y;
          sim.reheat(0.25);
        } else {
          cam.x = drag.vx + (sx - drag.sx); cam.y = drag.vy + (sy - drag.sy);
        }
        dirty = true;
        return;
      }
      // only hover when the pointer is on the graph itself, not on a menu or panel floating above it
      const hit = e.target === el ? nodeAt(sx, sy) : -1;
      if (hit !== hover) { hover = hit; el.style.cursor = hit >= 0 ? 'pointer' : 'grab'; dirty = true; }
    };
    const onUp = () => {
      if (drag && drag.node >= 0) {
        if (!drag.moved) onOpen(nodes[drag.node].id);
        nodes[drag.node].fx = null; nodes[drag.node].fy = null;
      }
      drag = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userMoved = true;
      glide = null;
      const { sx, sy } = pos(e);
      const before = toWorld(sx, sy);
      cam.k = Math.max(0.03, Math.min(6, cam.k * Math.exp(-e.deltaY * 0.0015)));
      cam.x = sx - w / 2 - before.x * cam.k;
      cam.y = sy - h / 2 - before.y * cam.k;
      dirty = true;
    };
    const onLeave = () => { if (hover >= 0) { hover = -1; dirty = true; } };

    el.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('mouseleave', onLeave);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      api.current = null;
      const ends = home;
      nodes.forEach((n, i) => placed.set(n.id, ends ? ends[i] : { x: n.x, y: n.y }));
      lastCam = { ...cam, moved: userMoved };
      el.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('mouseleave', onLeave);
    };
  }, [data, view.showOrphans, view.showUnresolved, onOpen]);

  return <canvas ref={canvas} className="graph-canvas" aria-label="Graph of notes in your second brain" />;
}
