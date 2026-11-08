// Force-directed layout in the shape of d3-force (and Obsidian's four graph sliders):
// link springs toward a target distance, Barnes-Hut many-body repulsion, a pull to the center,
// velocity decay, and an alpha that cools so the layout settles. Unlinked notes feel only
// repulsion and the center pull, which is what pushes orphans into Obsidian's outer ring.

export type SimNode = { x: number; y: number; vx: number; vy: number; r: number; deg: number; fx: number | null; fy: number | null };
export type GraphSettings = { centerStrength: number; repelStrength: number; linkStrength: number; linkDistance: number; nodeSizeMultiplier: number };

type Quad = { x: number; y: number; size: number; mass: number; cx: number; cy: number; node: SimNode | null; kids: (Quad | null)[] | null };

const THETA2 = 0.81;

// slider-to-force scale, fit so the layout matches Obsidian's proportions (see tuning notes in the project log)
export const TUNE = { charge: 5, center: 0.22, distance: 0.1 };

export class ForceSim {
  alpha = 1;
  readonly alphaMin = 0.004;
  private readonly alphaDecay = 1 - Math.pow(0.004, 1 / 320);
  private readonly velocityKeep = 0.6;
  private charge = 0;
  private center = 0;
  private distance = 0;
  private strengths: number[] = [];
  private readonly bias: number[];
  private readonly tune: typeof TUNE;
  // which notes take part; the timelapse switches them on one by one
  on: Uint8Array;

  nodes: SimNode[];
  links: [number, number][];

  constructor(nodes: SimNode[], links: [number, number][], s: GraphSettings, tune: Partial<typeof TUNE> = {}) {
    this.nodes = nodes;
    this.links = links;
    this.tune = { ...TUNE, ...tune };
    this.on = new Uint8Array(nodes.length).fill(1);
    this.configure(s);
    this.bias = links.map(([a, b]) => nodes[a].deg / Math.max(1, nodes[a].deg + nodes[b].deg));
    // phyllotaxis start, like d3, so the first frames already look like a disc
    const step = Math.PI * (3 - Math.sqrt(5));
    nodes.forEach((n, i) => {
      const r = 12 * Math.sqrt(0.5 + i);
      n.x = r * Math.cos(i * step);
      n.y = r * Math.sin(i * step);
      n.vx = n.vy = 0;
    });
  }

  // Obsidian's slider units mapped onto d3-scale forces; safe to call while running
  configure(s: GraphSettings) {
    const { nodes, tune: t } = this;
    this.charge = -s.repelStrength * t.charge;
    this.center = s.centerStrength * t.center;
    this.distance = s.linkDistance * t.distance;
    this.strengths = this.links.map(([a, b]) => s.linkStrength / Math.max(1, Math.min(nodes[a].deg, nodes[b].deg)));
  }

  reheat(to = 0.3) { this.alpha = Math.max(this.alpha, to); }
  get active() { return this.alpha > this.alphaMin; }

  tick() {
    const { nodes, links, alpha, on } = this;
    links.forEach(([ai, bi], i) => {
      if (!on[ai] || !on[bi]) return;
      const a = nodes[ai];
      const b = nodes[bi];
      let dx = b.x + b.vx - a.x - a.vx || 1e-6;
      let dy = b.y + b.vy - a.y - a.vy || 1e-6;
      let l = Math.sqrt(dx * dx + dy * dy);
      l = ((l - this.distance) / l) * alpha * this.strengths[i];
      dx *= l;
      dy *= l;
      b.vx -= dx * this.bias[i];
      b.vy -= dy * this.bias[i];
      a.vx += dx * (1 - this.bias[i]);
      a.vy += dy * (1 - this.bias[i]);
    });

    const root = this.buildQuad();
    nodes.forEach((n, i) => { if (on[i]) this.applyCharge(root, n, alpha); });

    for (let i = 0; i < nodes.length; i++) {
      if (!on[i]) continue;
      const n = nodes[i];
      n.vx -= n.x * this.center * alpha;
      n.vy -= n.y * this.center * alpha;
      if (n.fx != null) { n.x = n.fx; n.vx = 0; } else { n.vx *= this.velocityKeep; n.x += n.vx; }
      if (n.fy != null) { n.y = n.fy; n.vy = 0; } else { n.vy *= this.velocityKeep; n.y += n.vy; }
    }
    this.alpha += (0 - this.alpha) * this.alphaDecay;
  }

  private buildQuad(): Quad {
    const live = this.nodes.filter((_, i) => this.on[i]);
    if (!live.length) return { x: 0, y: 0, size: 1, mass: 0, cx: 0, cy: 0, node: null, kids: null };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of live) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const size = Math.max(x1 - x0, y1 - y0) + 1;
    const root: Quad = { x: x0, y: y0, size, mass: 0, cx: 0, cy: 0, node: null, kids: null };
    for (const n of live) this.insert(root, n, 0);
    this.accumulate(root);
    return root;
  }

  private insert(q: Quad, n: SimNode, depth: number) {
    if (!q.kids && !q.node) { q.node = n; return; }
    if (!q.kids) {
      if (depth > 40) return; // coincident points; skip rather than recurse forever
      const old = q.node!;
      q.node = null;
      q.kids = [null, null, null, null];
      this.insert(q, old, depth);
    }
    const h = q.size / 2;
    const ix = n.x >= q.x + h ? 1 : 0;
    const iy = n.y >= q.y + h ? 1 : 0;
    const k = iy * 2 + ix;
    q.kids![k] ??= { x: q.x + ix * h, y: q.y + iy * h, size: h, mass: 0, cx: 0, cy: 0, node: null, kids: null };
    this.insert(q.kids![k]!, n, depth + 1);
  }

  private accumulate(q: Quad) {
    if (q.node) { q.mass = 1; q.cx = q.node.x; q.cy = q.node.y; return; }
    let m = 0, x = 0, y = 0;
    for (const k of q.kids ?? []) {
      if (!k) continue;
      this.accumulate(k);
      m += k.mass; x += k.cx * k.mass; y += k.cy * k.mass;
    }
    q.mass = m; q.cx = m ? x / m : 0; q.cy = m ? y / m : 0;
  }

  private applyCharge(q: Quad, n: SimNode, alpha: number) {
    if (!q.mass) return;
    const dx = q.cx - n.x;
    const dy = q.cy - n.y;
    let l = dx * dx + dy * dy;
    // far enough away: treat the whole cell as one mass
    if (q.node === n) return;
    if (q.node || (q.size * q.size) / Math.max(l, 1e-9) < THETA2) {
      if (l < 1) l = 1;
      const w = (this.charge * alpha * q.mass) / l;
      n.vx += dx * w;
      n.vy += dy * w;
      return;
    }
    for (const k of q.kids ?? []) if (k) this.applyCharge(k, n, alpha);
  }
}
