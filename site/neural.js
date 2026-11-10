// Faint connector graphic behind the hero text: a sparse set of nodes in a 3D volume, turning slowly, with lines
// between nodes that sit near each other. Few nodes and a wide reach read as a very close view of a much larger
// network. The canvas keeps the CSS behind it visible; everything is drawn at low alpha.
(() => {
  const hero = document.querySelector('.hero');
  if (!hero) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const canvas = document.createElement('canvas');
  canvas.className = 'neural';
  canvas.setAttribute('aria-hidden', 'true');
  hero.insertBefore(canvas, hero.querySelector('.wrap'));
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const COUNT = 44;          // nodes in the volume
  const REACH = 0.34;        // link distance as a fraction of the shorter canvas side
  const SPEED = 0.000045;    // radians per millisecond, full turn in about 2.3 minutes
  const DEPTH = 1.9;         // camera distance in half-widths; larger is flatter
  const rand = (a, b) => a + Math.random() * (b - a);

  // nodes fill a flattened box: wider than tall, shallow in depth, so edges reach past the viewport on both sides
  const nodes = Array.from({ length: COUNT }, () => ({
    x: rand(-1.25, 1.25), y: rand(-0.85, 0.85), z: rand(-0.7, 0.7),
    r: rand(1.1, 2.4),
    // each node drifts on its own slow loop so the shape never settles
    px: rand(0, Math.PI * 2), py: rand(0, Math.PI * 2), pz: rand(0, Math.PI * 2),
    sx: rand(0.00004, 0.00009), sy: rand(0.00004, 0.00009), sz: rand(0.00003, 0.00007),
    ax: rand(0.04, 0.1), ay: rand(0.04, 0.1), az: rand(0.05, 0.12),
  }));

  let w = 0, h = 0, dpr = 1;
  function resize() {
    const rect = hero.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = Math.max(1, Math.round(rect.width));
    h = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const pts = new Array(COUNT);
  function frame(t) {
    ctx.clearRect(0, 0, w, h);
    const ry = t * SPEED, rx = Math.sin(t * SPEED * 0.37) * 0.22;
    const cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx);
    const half = Math.max(w, h) / 2, reach = Math.min(w, h) * REACH;
    for (let i = 0; i < COUNT; i++) {
      const n = nodes[i];
      const x0 = n.x + Math.sin(t * n.sx + n.px) * n.ax;
      const y0 = n.y + Math.sin(t * n.sy + n.py) * n.ay;
      const z0 = n.z + Math.sin(t * n.sz + n.pz) * n.az;
      // turn about the vertical axis, then tip a little about the horizontal one
      const x1 = x0 * cy + z0 * sy, z1 = -x0 * sy + z0 * cy;
      const y1 = y0 * cx - z1 * sx, z2 = y0 * sx + z1 * cx;
      const s = DEPTH / (DEPTH + z2);
      pts[i] = { x: w / 2 + x1 * half * s, y: h / 2 + y1 * half * 0.9 * s, s, r: n.r * s };
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
      ctx.fillStyle = 'rgba(207, 230, 255, ' + Math.min(1, 0.35 + p.s * 0.45).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
  }

  let running = false, raf = 0;
  const loop = (t) => { frame(t); raf = running ? requestAnimationFrame(loop) : 0; };
  function start() { if (running || reduce) return; running = true; raf = requestAnimationFrame(loop); }
  function stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }

  resize();
  if (window.ResizeObserver) new ResizeObserver(resize).observe(hero); else addEventListener('resize', resize);
  if (reduce) { frame(40000); return; }
  // only animate while the hero is on screen and the tab is visible
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => es.forEach((e) => (e.isIntersecting ? start() : stop())), { threshold: 0 }).observe(hero);
  } else start();
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
})();
