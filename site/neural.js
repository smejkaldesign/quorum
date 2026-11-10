// Faint connector graphics: a sparse set of nodes in a 3D volume, turning slowly, with lines between nodes that
// sit near each other. Few nodes and a wide reach read as a very close view of a much larger network. Two mounts:
// the hero, behind the copy, and the app frame, where a handful of large nodes drift behind and below the window.
// The canvas keeps the CSS behind it visible; everything is drawn at low alpha. Nearby nodes ease toward the cursor,
// and a node can be picked up, dragged and thrown; it then springs back to its place in the volume.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rand = (a, b) => a + Math.random() * (b - a);

  const MOUNTS = [
    { sel: '.hero', count: 44, reach: 0.34, speed: 0.000045, depth: 1.9, radius: [1.1, 2.4], box: [1.25, 0.85, 0.7], extend: 0, center: 0.5 },
    // far closer in: a few big nodes and long lines, centered on the frame's bottom edge so the visible part sits under
    // the window, running 320px past it into the gap below
    { sel: '.app-shot', count: 12, reach: 0.7, speed: 0.000028, depth: 2.4, radius: [3, 5.6], box: [1.3, 0.5, 0.6], extend: 320, center: 0.76 },
  ];

  const PULL_RADIUS = 220;   // px from the cursor where the pull starts
  const PULL = 0.42;         // fraction of the remaining distance a node closes at full strength
  const SPRING = 0.008;      // per-frame pull of a node's offset toward its target (home, or the cursor pull)
  const DAMP = 0.95;         // per-frame velocity kept; lower stops a thrown node sooner
  const GRAB = 16;           // px around a node that picks it up
  const THROW_MAX = 48;      // px per frame cap on release velocity

  function mount(host, cfg) {
    const canvas = document.createElement('canvas');
    canvas.className = 'neural';
    canvas.setAttribute('aria-hidden', 'true');
    host.insertBefore(canvas, host.querySelector('.wrap'));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const COUNT = cfg.count, [bx, by, bz] = cfg.box;

    const nodes = Array.from({ length: COUNT }, () => ({
      x: rand(-bx, bx), y: rand(-by, by), z: rand(-bz, bz),
      r: rand(cfg.radius[0], cfg.radius[1]),
      // each node drifts on its own slow loop so the shape never settles
      px: rand(0, Math.PI * 2), py: rand(0, Math.PI * 2), pz: rand(0, Math.PI * 2),
      sx: rand(0.00004, 0.00009), sy: rand(0.00004, 0.00009), sz: rand(0.00003, 0.00007),
      ax: rand(0.04, 0.1), ay: rand(0.04, 0.1), az: rand(0.05, 0.12),
    }));
    // screen-space offset from the projected position, with velocity, so hover pull and throws share one motion model
    const offs = Array.from({ length: COUNT }, () => ({ x: 0, y: 0, vx: 0, vy: 0 }));
    const pts = new Array(COUNT);
    const cursor = { x: -1e6, y: -1e6, on: false };
    // the held node: its index, where the pointer is, and the pointer's recent velocity for the throw
    const drag = { i: -1, x: 0, y: 0, vx: 0, vy: 0, lastT: 0 };

    const local = (e) => { const r = host.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height + cfg.extend }; };
    const hit = (x, y) => {
      let best = -1, bestD = Infinity;
      for (let i = 0; i < COUNT; i++) {
        const p = pts[i]; if (!p) continue;
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < Math.max(GRAB, p.r * 3) && d < bestD) { best = i; bestD = d; }
      }
      return best;
    };
    addEventListener('pointermove', (e) => {
      const l = local(e);
      cursor.x = l.x; cursor.y = l.y;
      cursor.on = l.x >= 0 && l.y >= 0 && l.x <= l.w && l.y <= l.h;
      if (drag.i >= 0) {
        const dt = Math.max(1, e.timeStamp - drag.lastT) / 16.7;
        // blend the pointer's speed over the last few moves so a flick reads as one velocity
        drag.vx = drag.vx * 0.5 + ((l.x - drag.x) / dt) * 0.5;
        drag.vy = drag.vy * 0.5 + ((l.y - drag.y) / dt) * 0.5;
        drag.x = l.x; drag.y = l.y; drag.lastT = e.timeStamp;
      } else if (cursor.on && !e.target.closest('a, button, input, textarea, iframe, select')) {
        host.style.cursor = hit(l.x, l.y) >= 0 ? 'grab' : '';
      } else host.style.cursor = '';
    }, { passive: true });
    document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) cursor.on = false; });
    host.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('a, button, input, textarea, iframe, select')) return;
      const l = local(e);
      const i = hit(l.x, l.y);
      if (i < 0) return;
      e.preventDefault();
      drag.i = i; drag.x = l.x; drag.y = l.y; drag.vx = 0; drag.vy = 0; drag.lastT = e.timeStamp;
      host.style.cursor = 'grabbing';
      try { host.setPointerCapture(e.pointerId); } catch {}
      start();
    });
    const release = (e) => {
      if (drag.i < 0) return;
      const o = offs[drag.i];
      // the throw: leave with the pointer's velocity, capped so a fast flick stays on screen
      const sp = Math.hypot(drag.vx, drag.vy), k = sp > THROW_MAX ? THROW_MAX / sp : 1;
      o.vx = drag.vx * k; o.vy = drag.vy * k;
      drag.i = -1;
      host.style.cursor = '';
      try { if (e && e.pointerId != null) host.releasePointerCapture(e.pointerId); } catch {}
    };
    host.addEventListener('pointerup', release);
    host.addEventListener('pointercancel', release);
    addEventListener('blur', () => release(null));

    let w = 0, h = 0, dpr = 1;
    function resize() {
      const rect = host.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = Math.max(1, Math.round(rect.width));
      h = Math.max(1, Math.round(rect.height + cfg.extend));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function frame(t) {
      ctx.clearRect(0, 0, w, h);
      const ry = t * cfg.speed, rx = Math.sin(t * cfg.speed * 0.37) * 0.22;
      const cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx);
      const half = Math.max(w, h) / 2, reach = Math.min(w, h) * cfg.reach;
      for (let i = 0; i < COUNT; i++) {
        const n = nodes[i];
        const x0 = n.x + Math.sin(t * n.sx + n.px) * n.ax;
        const y0 = n.y + Math.sin(t * n.sy + n.py) * n.ay;
        const z0 = n.z + Math.sin(t * n.sz + n.pz) * n.az;
        // turn about the vertical axis, then tip a little about the horizontal one
        const x1 = x0 * cy + z0 * sy, z1 = -x0 * sy + z0 * cy;
        const y1 = y0 * cx - z1 * sx, z2 = y0 * sx + z1 * cx;
        const s = cfg.depth / (cfg.depth + z2);
        const px = w / 2 + x1 * half * s, py = h * cfg.center + y1 * half * 0.9 * s;
        const o = offs[i];
        if (i === drag.i) {
          // held: sit under the pointer, no velocity of its own until release
          o.x = drag.x - px; o.y = drag.y - py; o.vx = 0; o.vy = 0;
        } else {
          // target offset: toward the cursor, strongest at the cursor, gone at the radius edge (smoothstep falloff)
          let tx = 0, ty = 0;
          if (cursor.on && drag.i < 0) {
            const dx = cursor.x - px, dy = cursor.y - py, d = Math.hypot(dx, dy);
            if (d < PULL_RADIUS && d > 0.001) {
              const u = 1 - d / PULL_RADIUS, k = u * u * (3 - 2 * u) * PULL;
              tx = dx * k; ty = dy * k;
            }
          }
          // a damped spring toward the target carries both the hover pull and the flight after a throw
          o.vx = (o.vx + (tx - o.x) * SPRING) * DAMP;
          o.vy = (o.vy + (ty - o.y) * SPRING) * DAMP;
          o.x += o.vx; o.y += o.vy;
        }
        pts[i] = { x: px + o.x, y: py + o.y, s, r: n.r * s };
      }
      ctx.lineWidth = 1;
      for (let i = 0; i < COUNT; i++) {
        const a = pts[i];
        for (let j = i + 1; j < COUNT; j++) {
          const b = pts[j];
          const dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy);
          if (d > reach) continue;
          // lines fade with length and with distance from the camera
          const k = (1 - d / reach) * Math.min(a.s, b.s) * 0.55;
          if (k < 0.01) continue;
          ctx.strokeStyle = 'rgba(207, 230, 255, ' + k.toFixed(3) + ')';
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
      for (let i = 0; i < COUNT; i++) {
        const p = pts[i];
        const held = i === drag.i;
        ctx.fillStyle = 'rgba(207, 230, 255, ' + Math.min(1, (held ? 0.6 : 0.35) + p.s * 0.45).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(p.x, p.y, held ? p.r * 1.35 : p.r, 0, Math.PI * 2); ctx.fill();
      }
    }

    let running = false, raf = 0;
    const loop = (t) => { frame(t); raf = running ? requestAnimationFrame(loop) : 0; };
    function start() { if (running || reduce) return; running = true; raf = requestAnimationFrame(loop); }
    function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }

    resize();
    if (window.ResizeObserver) new ResizeObserver(resize).observe(host); else addEventListener('resize', resize);
    if (reduce) { frame(40000); return; }
    // only animate while the host is on screen and the tab is visible
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((es) => es.forEach((e) => (e.isIntersecting ? start() : stop())), { threshold: 0, rootMargin: cfg.extend + 'px 0px' }).observe(host);
    } else start();
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  }

  for (const cfg of MOUNTS) { const host = document.querySelector(cfg.sel); if (host) mount(host, cfg); }
})();
