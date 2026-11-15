// Starfield behind the app frame: the same field the CSS draws on `.stars` (two layers drifting down and to the right,
// solid white stars mixed with fainter ones), drawn on a canvas so each star can move. Stars within MAGNET_RADIUS of
// the cursor are pulled toward it over MAGNET_TIME, slowly at first and fastest at the end. The pull falls off with
// the square of the distance, so a star next to the cursor ends on it and a star at the edge of the radius barely
// moves. Stars ease back when the cursor moves away.
// Once the canvas is up, `.stars-live` turns the CSS layers off. Without this script the CSS field still shows.
// The mask on `.stars` fades the canvas like it fades the CSS layers. Under reduced motion it draws one still frame.
(() => {
  const host = document.querySelector('.stars');
  if (!host) return;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  // appended after the streaks, so their :nth-child positions keep working
  host.appendChild(canvas);
  host.classList.add('stars-live');

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rand = (a, b) => a + Math.random() * (b - a);

  const DENSITY = 0.0016;      // stars per square px, a little over the two CSS tiles combined
  const MAX_STARS = 2400;
  const EDGE = 12;             // px past each edge where a star wraps to the other side
  // px per second, matching the CSS drifts: 440px by 220px in 28s, and 320px by 160px in 44s
  const LAYERS = [{ vx: 440 / 28, vy: 220 / 28 }, { vx: 320 / 44, vy: 160 / 44 }];
  const MAGNET_RADIUS = 220;   // px from the cursor where the pull starts
  const MAGNET_TIME = 2000;    // ms from the cursor arriving to a star reaching the end of its pull
  const MAGNET_RELEASE = 600;  // ms outside the radius before a star's next pull starts from rest again
  // share of the remaining offset a star covers per 60fps frame: FOLLOW keeps a pulled star on its curve while the
  // cursor moves, EASE_OUT takes it home
  const FOLLOW = 0.25;
  const EASE_OUT = 0.1;

  let w = 1, h = 1, dpr = 1, stars = [];
  const cursor = { x: 0, y: 0, on: false };

  function seed() {
    const count = Math.min(MAX_STARS, Math.round(w * h * DENSITY));
    stars = Array.from({ length: count }, () => {
      const size = Math.random();
      const layer = LAYERS[Math.random() < 0.45 ? 0 : 1];
      return {
        x: rand(-EDGE, w + EDGE), y: rand(-EDGE, h + EDGE),
        ox: 0, oy: 0, // offset from the drifting position, set by the cursor pull
        near: 0,      // ms of pull this star has built up, from 0 to MAGNET_TIME
        vx: layer.vx, vy: layer.vy,
        // a canvas dot has a hard edge, so these are a little larger than the CSS dots to read the same
        r: size < 0.68 ? 0.95 : size < 0.92 ? 1.25 : 1.65,
        // a little over half are solid white, the rest sit between 30% and 60%
        a: Math.random() < 0.55 ? 1 : rand(0.3, 0.6),
      };
    });
  }

  function resize() {
    const rect = host.getBoundingClientRect();
    const nw = Math.max(1, Math.round(rect.width)), nh = Math.max(1, Math.round(rect.height));
    const ndpr = Math.min(2, window.devicePixelRatio || 1);
    if (nw === w && nh === h && ndpr === dpr && stars.length) return;
    w = nw; h = nh; dpr = ndpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    seed();
    if (reduce) draw(0);
  }

  function draw(dt) {
    const drift = dt / 1000;
    const follow = 1 - Math.pow(1 - FOLLOW, dt / 16.7);
    const easeOut = 1 - Math.pow(1 - EASE_OUT, dt / 16.7);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    for (const s of stars) {
      s.x += s.vx * drift; s.y += s.vy * drift;
      if (s.x > w + EDGE) s.x -= w + EDGE * 2;
      if (s.y > h + EDGE) s.y -= h + EDGE * 2;
      let tx = 0, ty = 0, inside = false;
      if (cursor.on) {
        const dx = cursor.x - s.x, dy = cursor.y - s.y;
        const d = Math.hypot(dx, dy);
        if (d < MAGNET_RADIUS) {
          inside = true;
          s.near = Math.min(MAGNET_TIME, s.near + dt);
          // share of the way to the cursor this star ends up: 1 next to it, 0 at the edge of the radius
          const reach = (1 - d / MAGNET_RADIUS) ** 2;
          // cubic ease-in over MAGNET_TIME: an eighth of the way at half time, all of it at the end
          const progress = (s.near / MAGNET_TIME) ** 3;
          tx = dx * reach * progress; ty = dy * reach * progress;
        }
      }
      if (!inside) s.near = Math.max(0, s.near - dt * (MAGNET_TIME / MAGNET_RELEASE));
      const ease = inside ? follow : easeOut;
      s.ox += (tx - s.ox) * ease; s.oy += (ty - s.oy) * ease;
      ctx.globalAlpha = s.a;
      ctx.beginPath();
      ctx.arc(s.x + s.ox, s.y + s.oy, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  let raf = 0, last = 0, visible = false;
  function frame(t) {
    raf = requestAnimationFrame(frame);
    const dt = last ? Math.min(50, t - last) : 16.7;
    last = t;
    draw(dt);
  }
  function start() { if (!raf && visible && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); } }
  function stop() { cancelAnimationFrame(raf); raf = 0; }

  resize();
  if (window.ResizeObserver) new ResizeObserver(resize).observe(host); else addEventListener('resize', resize);
  if (reduce) return;

  // the field has pointer-events off and sits behind the frame, so the cursor is read from the window
  addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const r = host.getBoundingClientRect();
    cursor.x = e.clientX - r.left; cursor.y = e.clientY - r.top; cursor.on = true;
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { cursor.on = false; });
  addEventListener('blur', () => { cursor.on = false; });

  // only animate while the field is on screen and the tab is visible
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((es) => es.forEach((e) => { visible = e.isIntersecting; if (visible) start(); else stop(); }), { threshold: 0 }).observe(host);
  } else { visible = true; start(); }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
})();
