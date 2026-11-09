// Decorative knowledge graph for "How it works": about 1,200 notes in folder
// clusters around an index note. A camera zooms between the whole graph and
// single clusters while a cursor hovers notes to show how they cluster.
// Runs only while on screen; under reduced motion it draws one still frame.
(function () {
  var root = document.querySelector("[data-graph]");
  if (!root) return;

  // seeded random, so the graph is the same on every visit
  var seed = 7;
  function rand() {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function gauss() { return (rand() + rand() + rand() - 1.5) / 1.5; }
  function pick(list) { return list[Math.floor(rand() * list.length)]; }

  var TOPICS = ["Weekly planning", "Customer call", "Design review", "Pricing sync", "Roadmap review", "1:1", "Retro", "Hiring panel", "Standup", "Launch prep", "Onboarding", "Partner intro", "Budget review", "Interview", "Demo"];
  var NAMES = ["Ava", "Ben", "Chloe", "Dev", "Elena", "Felix", "Grace", "Hugo", "Iris", "Jon", "Kai", "Lena", "Mateo", "Nina", "Omar", "Priya", "Quinn", "Rosa", "Sam", "Tara"];
  var WORDS = ["pricing", "onboarding", "search", "sync", "billing", "privacy", "agents", "memory", "launch", "hiring", "roadmap", "research", "design", "support", "security", "analytics", "mobile", "teams"];
  function day(i) { var d = 1 + (i % 28); return "2026-" + String(10 + (i % 2)).padStart(2, "0") + "-" + String(d).padStart(2, "0"); }

  var CLUSTERS = [
    { name: "meetings", color: "#b794f6", angle: -95, dist: 330, count: 240, spread: 105, label: function (i) { return day(i) + " " + pick(TOPICS); } },
    { name: "research", color: "#a78bfa", angle: -12, dist: 300, count: 140, spread: 80, label: function () { return pick(WORDS) + "-" + pick(["notes", "findings", "survey", "benchmarks", "interviews"]); } },
    { name: "people", color: "#f6ad55", angle: 180, dist: 390, count: 90, spread: 45, label: function () { return pick(NAMES) + " " + pick(["(design)", "(eng)", "(sales)", "(ops)", "(advisor)"]); } },
    { name: "customers", color: "#f687b3", angle: 145, dist: 330, count: 40, spread: 28, label: function () { return pick(["Northwind", "Acme", "Globex", "Initech", "Umbrella", "Hooli", "Stark", "Wayne"]) + " account"; } },
    { name: "projects", color: "#63b3ed", angle: 168, dist: 230, count: 50, spread: 40, label: function () { return pick(WORDS) + "-" + pick(["v2", "launch", "refresh", "pilot", "migration"]); } },
    { name: "decisions", color: "#4fd1c5", angle: 2, dist: 450, count: 34, spread: 20, label: function (i) { return "decision-" + String(100 + i); } },
    { name: "design", color: "#f6e05e", angle: 22, dist: 430, count: 24, spread: 14, label: function () { return pick(WORDS) + " spec"; } },
    { name: "hiring", color: "#f6e05e", angle: 122, dist: 410, count: 30, spread: 22, label: function () { return pick(["Designer", "Engineer", "PM", "Recruiter"]) + " loop " + Math.floor(rand() * 9 + 1); } },
    { name: "inbox", color: "#9ae6b4", angle: -152, dist: 370, count: 18, spread: 14, label: function () { return "idea: " + pick(WORDS); } },
    { name: "ideas", color: "#9ae6b4", angle: -42, dist: 385, count: 14, spread: 10, label: function () { return "idea: " + pick(WORDS); } },
    { name: "tasks", color: "#c6f68d", angle: 70, dist: 300, count: 60, spread: 70, label: function () { return "todo " + pick(WORDS); } },
    { name: "notes", color: "#f687b3", angle: 92, dist: 445, count: 18, spread: 13, label: function () { return pick(WORDS) + " notes"; } },
  ];

  var nodes = [];
  var edges = [];
  function add(n) { n.id = nodes.length; n.deg = 0; n.links = []; nodes.push(n); return n; }
  function link(a, b) { if (a === b) return; edges.push([a, b]); a.deg++; b.deg++; a.links.push(b); b.links.push(a); }

  var hub = add({ x: 0, y: 0, color: "#a3c8ff", label: "CLAUDE.md", cluster: "index" });

  // daily notes packed around the index
  var daily = [];
  for (var i = 0; i < 300; i++) {
    var a = rand() * Math.PI * 2, r = 46 + Math.sqrt(rand()) * 62;
    var d = add({ x: Math.cos(a) * r, y: Math.sin(a) * r, color: "#8e8e93", label: "Daily " + day(i), cluster: "daily notes" });
    daily.push(d);
    link(d, hub);
  }

  CLUSTERS.forEach(function (c) {
    var rad = c.angle * Math.PI / 180;
    c.x = Math.cos(rad) * c.dist; c.y = Math.sin(rad) * c.dist;
    c.members = [];
    for (var i = 0; i < c.count; i++) {
      var n = add({ x: c.x + gauss() * c.spread, y: c.y + gauss() * c.spread, color: c.color, label: c.label(i), cluster: c.name });
      c.members.push(n);
    }
    // a few local hubs gather most of the cluster's links
    var heads = c.members.slice(0, Math.max(2, Math.round(c.count / 40)));
    c.members.forEach(function (n) {
      var best = null, bd = Infinity;
      for (var k = 0; k < 6; k++) {
        var m = pick(c.members), dd = (m.x - n.x) * (m.x - n.x) + (m.y - n.y) * (m.y - n.y);
        if (m !== n && dd < bd) { bd = dd; best = m; }
      }
      if (best) link(n, best);
      if (rand() < 0.5) link(n, pick(heads));
      if (rand() < 0.07) link(n, hub);
    });
  });

  // a mixed band between the index and the clusters
  for (var j = 0; j < 180; j++) {
    var c = pick(CLUSTERS), ang = rand() * Math.PI * 2, rr = 140 + rand() * 200;
    var n = add({ x: Math.cos(ang) * rr, y: Math.sin(ang) * rr, color: c.color, label: c.label(j), cluster: c.name });
    c.members.push(n);
    link(n, pick(c.members));
    if (rand() < 0.2) link(n, hub);
  }
  // a few cross-cluster links
  for (var k = 0; k < 120; k++) link(pick(pick(CLUSTERS).members), pick(pick(CLUSTERS).members));

  // unlinked notes in a faint outer ring
  var orphans = [];
  for (var o = 0; o < 260; o++) {
    var oa = rand() * Math.PI * 2, or = 560 + rand() * 90;
    orphans.push(add({ x: Math.cos(oa) * or, y: Math.sin(oa) * or * 0.92, color: "#8e8e93", label: pick(WORDS) + " draft", cluster: "unlinked", orphan: true }));
  }

  var byRadius;
  var counts = {};
  nodes.forEach(function (n) {
    counts[n.cluster] = (counts[n.cluster] || 0) + 1;
    n.r = n === hub ? 24 : n.orphan ? 1.1 : n.cluster === "daily notes" ? 1.5 : Math.min(9, 1.8 + Math.sqrt(n.deg) * 0.75);
  });
  byRadius = nodes.slice().sort(function (a, b) { return b.r - a.r; });

  // canvas and overlays
  var canvas = document.createElement("canvas");
  var ctx = canvas.getContext("2d");
  var tip = document.createElement("div");
  tip.className = "g-tip";
  root.appendChild(canvas);
  root.appendChild(tip);

  var W = 0, H = 0, dpr = 1, fit = 1;
  function size() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = root.clientWidth; H = root.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    fit = Math.min(W / 1260, H / 1140);
  }
  size();

  var cam = { x: 0, y: 0, s: fit };
  var hover = null;
  function toScreen(n) { return { x: (n.x - cam.x) * cam.s + W / 2, y: (n.y - cam.y) * cam.s + H / 2 }; }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var z = cam.s / fit;
    var focus = hover ? hover.cluster : null;

    ctx.setTransform(cam.s * dpr, 0, 0, cam.s * dpr, (W / 2 - cam.x * cam.s) * dpr, (H / 2 - cam.y * cam.s) * dpr);
    ctx.lineWidth = 0.6 / cam.s;
    ctx.strokeStyle = "rgba(255,255,255," + (focus ? 0.025 : Math.min(0.09, 0.05 + z * 0.006)) + ")";
    ctx.beginPath();
    edges.forEach(function (e) { ctx.moveTo(e[0].x, e[0].y); ctx.lineTo(e[1].x, e[1].y); });
    ctx.stroke();
    if (hover) {
      ctx.strokeStyle = hover.color;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1.2 / cam.s;
      ctx.beginPath();
      hover.links.forEach(function (m) { ctx.moveTo(hover.x, hover.y); ctx.lineTo(m.x, m.y); });
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    nodes.forEach(function (n) {
      var dim = focus && n.cluster !== focus && n !== hover && hover.links.indexOf(n) === -1;
      ctx.globalAlpha = n.orphan ? (dim ? 0.12 : 0.4) : dim ? 0.18 : 0.95;
      ctx.fillStyle = n.color;
      ctx.beginPath();
      ctx.arc(n.x, n.y, Math.max(n.r / Math.sqrt(z), 0.9 / cam.s), 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    if (hover) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2 / cam.s;
      ctx.beginPath();
      ctx.arc(hover.x, hover.y, hover.r / Math.sqrt(z) + 3 / cam.s, 0, Math.PI * 2);
      ctx.stroke();
    }

    // labels fade in as the camera zooms; each is placed only where it overlaps no other
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var la = Math.max(0, Math.min(1, (z - 1.8) / 1.2));
    if (la > 0) {
      ctx.font = "11px -apple-system, BlinkMacSystemFont, Inter, system-ui, sans-serif";
      ctx.textBaseline = "middle";
      var placed = [];
      var order = hover ? [hover].concat(byRadius) : byRadius;
      for (var i = 0; i < order.length && placed.length < 45; i++) {
        var n = order[i];
        if (n.orphan || n.cluster === "daily notes" || (i > 0 && n === hover)) continue;
        var p = toScreen(n), rs = n.r * fit * Math.sqrt(z);
        if (p.x < 0 || p.x > W - 40 || p.y < 12 || p.y > H - 12 || rs < 2.4) continue;
        var box = { x: p.x + rs + 4, y: p.y - 8, w: ctx.measureText(n.label).width + 6, h: 16 };
        if (placed.some(function (q) { return box.x < q.x + q.w && q.x < box.x + box.w && box.y < q.y + q.h && q.y < box.y + box.h; })) continue;
        placed.push(box);
        var dim = focus && n.cluster !== focus && n !== hover;
        ctx.fillStyle = "rgba(236,236,238," + (la * (dim ? 0.25 : 0.8)) + ")";
        ctx.fillText(n.label, box.x + 2, p.y);
      }
    }

    if (hover) {
      var hp = toScreen(hover);
      tip.style.transform = "translate(" + Math.round(Math.min(W - 230, hp.x + 16)) + "px," + Math.round(hp.y - 54) + "px)";
    }
  }

  function showTip(n) {
    var what = n === hub ? "Index note · links to " + n.deg + " notes" : n.orphan ? "Unlinked · no connections yet" : n.cluster + " cluster · " + counts[n.cluster] + " notes · " + n.deg + " links";
    tip.innerHTML = "<strong>" + n.label + "</strong><span>" + what + "</span>";
    tip.classList.add("show");
  }

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    draw();
    new ResizeObserver(function () { size(); cam.s = fit; draw(); }).observe(root);
    return;
  }

  var cursor = document.createElement("div");
  cursor.className = "t-cursor";
  cursor.innerHTML = '<svg viewBox="0 0 16 16"><path d="M2 1.5l11 6.2-4.6 1.1 2.6 5-1.9.9-2.6-5L3 12.5z" fill="#fff" stroke="#0b1530" stroke-width="1" stroke-linejoin="round"/></svg>';
  cursor.style.transition = "none";
  root.appendChild(cursor);
  var cur = { x: W * 0.7, y: H * 0.7 }, aim = null;

  var visible = false, waiters = [], tween = null;
  function frame(t) {
    if (tween) {
      var k = Math.min(1, (t - tween.t0) / tween.ms), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      cam.x = tween.a.x + (tween.b.x - tween.a.x) * e;
      cam.y = tween.a.y + (tween.b.y - tween.a.y) * e;
      cam.s = tween.a.s * Math.pow(tween.b.s / tween.a.s, e);
      if (k === 1) { var done = tween.done; tween = null; done(); }
    }
    if (aim) {
      var p = toScreen(aim);
      cur.x += (p.x - cur.x) * 0.14; cur.y += (p.y - cur.y) * 0.14;
    }
    cursor.style.transform = "translate(" + cur.x + "px," + cur.y + "px)";
    draw();
    if (visible) requestAnimationFrame(frame);
  }
  new IntersectionObserver(function (entries) {
    var was = visible;
    visible = entries[0].isIntersecting;
    if (visible && !was) {
      requestAnimationFrame(frame);
      waiters.forEach(function (w) { w(); });
      waiters = [];
    }
  }).observe(root);
  new ResizeObserver(size).observe(root);

  function sleep(ms) {
    return new Promise(function (done) { setTimeout(done, ms); }).then(function () {
      return visible ? null : new Promise(function (done) { waiters.push(done); });
    });
  }
  function fly(x, y, zoom, ms) {
    return new Promise(function (done) {
      tween = { a: { x: cam.x, y: cam.y, s: cam.s }, b: { x: x, y: y, s: fit * zoom }, ms: ms, t0: performance.now(), done: done };
    });
  }
  function point(n) {
    aim = n;
    return sleep(900).then(function () { hover = n; showTip(n); });
  }
  function leave() { hover = null; tip.classList.remove("show"); return sleep(350); }
  function cluster(name) { return CLUSTERS.filter(function (c) { return c.name === name; })[0]; }
  function biggest(c) { return c.members.slice().sort(function (a, b) { return b.deg - a.deg; })[0]; }

  var meetings = cluster("meetings"), people = cluster("people"), decisions = cluster("decisions");
  var mHead = biggest(meetings);
  var mNear = mHead.links.filter(function (n) { return n.cluster === "meetings"; })[0] || meetings.members[5];

  function loop() {
    return sleep(1400)
      .then(function () { return point(biggest(cluster("research"))); })
      .then(function () { return sleep(1800); })
      .then(leave)
      .then(function () { return point(hub); })
      .then(function () { return sleep(1500); })
      .then(leave)
      .then(function () { return fly(meetings.x, meetings.y, 2.6, 2200); })
      .then(function () { return point(mHead); })
      .then(function () { return sleep(1900); })
      .then(leave)
      .then(function () { return fly(mNear.x, mNear.y, 4.5, 1800); })
      .then(function () { return point(mNear); })
      .then(function () { return sleep(1900); })
      .then(leave)
      .then(function () { return fly(people.x, people.y, 3.2, 2200); })
      .then(function () { return point(biggest(people)); })
      .then(function () { return sleep(1900); })
      .then(leave)
      .then(function () { return fly(decisions.x, decisions.y, 4.2, 2200); })
      .then(function () { return point(biggest(decisions)); })
      .then(function () { return sleep(1900); })
      .then(leave)
      .then(function () { return fly(0, 0, 1, 2400); })
      .then(function () { return point(orphans[17]); })
      .then(function () { return sleep(1700); })
      .then(leave)
      .then(loop);
  }
  cam.s = fit;
  draw();
  loop();
})();
