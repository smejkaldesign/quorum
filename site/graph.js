// Decorative knowledge graph for "How it works": a cursor picks a note, the
// page opens, a link in it leads to the next note, and it returns to the graph.
// Runs only while on screen; under reduced motion it renders once, still.
(function () {
  var root = document.querySelector("[data-graph]");
  if (!root) return;

  var W = 760, H = 520;
  var NODES = [
    { id: "pricing", label: "Pricing sync", x: 288, y: 190, g: "m" },
    { id: "review", label: "Design review", x: 475, y: 300, g: "m" },
    { id: "customer", label: "Customer call", x: 212, y: 330, g: "m" },
    { id: "weekly", label: "Weekly planning", x: 450, y: 140, g: "m" },
    { id: "principles", label: "pricing-principles", x: 112, y: 230, g: "k" },
    { id: "decisions", label: "decision-log", x: 362, y: 250, g: "k" },
    { id: "interviews", label: "interview-notes", x: 100, y: 420, g: "k" },
    { id: "launch", label: "quorum-launch", x: 575, y: 210, g: "p" },
    { id: "roadmap", label: "roadmap", x: 625, y: 370, g: "p" },
    { id: "refresh", label: "website-refresh", x: 412, y: 410, g: "p" },
    { id: "team", label: "team", x: 588, y: 90, g: "o" },
    { id: "customers", label: "customers", x: 275, y: 460, g: "o" },
    { id: "claude", label: "CLAUDE.md", x: 188, y: 110, g: "o" },
  ];
  var EDGES = [
    ["pricing", "principles"], ["pricing", "decisions"], ["pricing", "weekly"], ["pricing", "customer"],
    ["review", "decisions"], ["review", "launch"], ["review", "refresh"], ["review", "roadmap"],
    ["customer", "interviews"], ["customer", "customers"], ["customer", "principles"],
    ["weekly", "launch"], ["weekly", "team"], ["decisions", "launch"], ["decisions", "principles"],
    ["launch", "roadmap"], ["refresh", "launch"], ["interviews", "customers"], ["team", "review"],
    ["claude", "pricing"], ["claude", "weekly"], ["claude", "principles"],
  ];
  var PAGES = {
    pricing: {
      meta: "meetings · Nov 8 · 32 min", title: "Pricing sync",
      body: "<h5>Decisions</h5><ul><li>One paid plan at $5 per seat</li><li>Open source stays free and complete</li></ul><h5>Action items</h5><ul><li>Draft the pricing page copy</li></ul>",
      links: ["principles", "decisions"],
    },
    principles: {
      meta: "knowledge · updated Nov 8", title: "pricing-principles",
      body: "<h5>Principles</h5><ul><li>Charge for hosting, never for features</li><li>No token billing in v1</li><li>One plan until teams ask for more</li></ul>",
      links: ["pricing", "customer"],
    },
    review: {
      meta: "meetings · Nov 7 · 45 min", title: "Design review",
      body: "<h5>Decisions</h5><ul><li>Hero leads with meeting notes for agents</li><li>Ship the providers row before launch</li></ul><h5>Open questions</h5><ul><li>Which screenshots go on the site</li></ul>",
      links: ["launch", "refresh"],
    },
    launch: {
      meta: "projects · updated Nov 7", title: "quorum-launch",
      body: "<h5>Milestones</h5><ul><li>Signed and notarized build</li><li>Site live at quorum.watch</li><li>Cloud sign-ups open</li></ul>",
      links: ["review", "roadmap"],
    },
  };
  var LABEL = {};
  NODES.forEach(function (n) { LABEL[n.id] = n.label; });

  var NS = "http://www.w3.org/2000/svg";
  var svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  var gEdges = document.createElementNS(NS, "g");
  var gNodes = document.createElementNS(NS, "g");
  svg.appendChild(gEdges);
  svg.appendChild(gNodes);

  var degree = {};
  EDGES.forEach(function (e) { degree[e[0]] = (degree[e[0]] || 0) + 1; degree[e[1]] = (degree[e[1]] || 0) + 1; });
  var byId = {};
  NODES.forEach(function (n, i) {
    n.phase = i * 1.7;
    var g = document.createElementNS(NS, "g");
    g.setAttribute("class", "g-node g-" + n.g);
    var c = document.createElementNS(NS, "circle");
    c.setAttribute("r", 4 + Math.sqrt(degree[n.id] || 1) * 2);
    var t = document.createElementNS(NS, "text");
    t.setAttribute("x", 12 + (degree[n.id] || 1));
    t.setAttribute("y", 4);
    t.textContent = n.label;
    g.appendChild(c);
    g.appendChild(t);
    gNodes.appendChild(g);
    n.el = g;
    n.dot = c;
    byId[n.id] = n;
  });
  var lines = EDGES.map(function (e) {
    var l = document.createElementNS(NS, "line");
    l.setAttribute("class", "g-edge");
    gEdges.appendChild(l);
    return { a: byId[e[0]], b: byId[e[1]], el: l };
  });

  function place(t) {
    NODES.forEach(function (n) {
      n.cx = n.x + Math.sin(t / 1600 + n.phase) * 3;
      n.cy = n.y + Math.cos(t / 1900 + n.phase) * 3;
      n.el.setAttribute("transform", "translate(" + n.cx + " " + n.cy + ")");
    });
    lines.forEach(function (l) {
      l.el.setAttribute("x1", l.a.cx); l.el.setAttribute("y1", l.a.cy);
      l.el.setAttribute("x2", l.b.cx); l.el.setAttribute("y2", l.b.cy);
    });
  }

  function focus(id) {
    svg.classList.toggle("focused", !!id);
    NODES.forEach(function (n) { n.el.classList.remove("on", "near"); });
    lines.forEach(function (l) {
      var hit = id && (l.a.id === id || l.b.id === id);
      l.el.classList.toggle("on", !!hit);
      if (hit) { l.a.el.classList.add("near"); l.b.el.classList.add("near"); }
    });
    if (id) byId[id].el.classList.add("on");
  }

  var page = document.createElement("div");
  page.className = "g-page";
  root.appendChild(svg);
  root.appendChild(page);

  function showPage(id) {
    var p = PAGES[id];
    page.innerHTML =
      '<span class="g-back">← Graph</span>' +
      '<p class="g-meta">' + p.meta + "</p>" +
      "<h4>" + p.title + "</h4>" +
      '<div class="g-body">' + p.body + "</div>" +
      '<p class="g-linked">Linked notes</p>' +
      '<div class="g-links">' + p.links.map(function (l) { return '<span class="g-link" data-to="' + l + '">' + LABEL[l] + "</span>"; }).join("") + "</div>";
    page.classList.add("show");
  }
  function hidePage() { page.classList.remove("show"); }

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    place(0);
    focus("pricing");
    return;
  }

  var cursor = document.createElement("div");
  cursor.className = "t-cursor";
  cursor.innerHTML = '<svg viewBox="0 0 16 16"><path d="M2 1.5l11 6.2-4.6 1.1 2.6 5-1.9.9-2.6-5L3 12.5z" fill="#fff" stroke="#0b1530" stroke-width="1" stroke-linejoin="round"/></svg>';
  root.appendChild(cursor);

  var visible = false;
  var waiters = [];
  var raf = 0;
  function frame(t) { place(t); raf = visible ? requestAnimationFrame(frame) : 0; }
  new IntersectionObserver(function (entries) {
    visible = entries[0].isIntersecting;
    if (visible) {
      if (!raf) raf = requestAnimationFrame(frame);
      waiters.forEach(function (w) { w(); });
      waiters = [];
    }
  }).observe(root);
  place(0);

  function sleep(ms) {
    return new Promise(function (done) { setTimeout(done, ms); }).then(function () {
      return visible ? null : new Promise(function (done) { waiters.push(done); });
    });
  }
  function moveToEl(el) {
    var r = el.getBoundingClientRect();
    var f = root.getBoundingClientRect();
    cursor.style.transform = "translate(" + (r.left - f.left + r.width / 2) + "px," + (r.top - f.top + r.height / 2) + "px)";
    return sleep(700);
  }
  function node(id) { return moveToEl(byId[id].dot); }
  function link(id) { return moveToEl(page.querySelector('[data-to="' + id + '"]')); }
  function back() { return moveToEl(page.querySelector(".g-back")); }
  function click() {
    cursor.classList.add("press");
    return sleep(140).then(function () { cursor.classList.remove("press"); return sleep(120); });
  }

  // one visit: pick a node, read its page, follow a link, read, go back
  function visit(start, next) {
    return node(start)
      .then(click)
      .then(function () { focus(start); return sleep(800); })
      .then(function () { showPage(start); return sleep(1800); })
      .then(function () { return link(next); })
      .then(click)
      .then(function () { focus(next); showPage(next); return sleep(1800); })
      .then(back)
      .then(click)
      .then(function () { hidePage(); return sleep(1300); });
  }

  function loop() {
    return sleep(800)
      .then(function () { return visit("pricing", "principles"); })
      .then(function () { return visit("review", "launch"); })
      .then(function () { focus(null); return sleep(1200); })
      .then(loop);
  }
  loop();
})();
