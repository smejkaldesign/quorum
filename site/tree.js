// Decorative Agent OS folder tree for the "Already have an Agent OS?" section.
// A cursor opens folders, selects notes and scrolls, and Quorum writes a new
// meeting note into the folder. It only runs while the section is on screen;
// under reduced motion it renders once as a still tree.
(function () {
  var root = document.querySelector("[data-tree]");
  if (!root) return;

  var TREE = [
    { name: "CLAUDE.md" },
    { name: "inbox", kids: [{ name: "ideas.md" }, { name: "follow-ups.md" }] },
    {
      name: "meetings",
      kids: [
        { name: "2026-11-03 Weekly planning.md" },
        { name: "2026-11-05 Customer call.md" },
        { name: "2026-11-07 Design review.md", id: "review" },
        { name: "2026-11-08 Pricing sync.md", id: "new", fresh: true },
      ],
    },
    {
      name: "projects",
      kids: [
        { name: "quorum-launch.md", id: "launch" },
        { name: "website-refresh.md" },
        { name: "hiring-plan.md" },
        { name: "roadmap.md" },
      ],
    },
    {
      name: "knowledge",
      kids: [{ name: "pricing-principles.md" }, { name: "decision-log.md" }, { name: "interview-notes.md" }],
    },
    { name: "people", kids: [{ name: "team.md" }, { name: "customers.md" }] },
    { name: "README.md" },
  ];

  var CHEVRON = '<svg class="t-chev" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var FOLDER = '<svg class="t-icon" viewBox="0 0 16 16"><path d="M1.75 3.5h4.1l1.4 1.6h7v7.65a.75.75 0 0 1-.75.75H2.5a.75.75 0 0 1-.75-.75z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  var FILE = '<svg class="t-icon" viewBox="0 0 16 16"><path d="M3.5 1.75h6l3 3v9.5h-9zM9.5 1.75v3h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';

  var rows = {};
  var list = document.createElement("div");
  list.className = "t-list";

  function build(items, depth, parent) {
    items.forEach(function (item) {
      var row = document.createElement("div");
      row.className = "t-row" + (item.kids ? " t-folder" : "");
      row.style.setProperty("--depth", depth);
      row.innerHTML =
        (item.kids ? CHEVRON : '<span class="t-chev"></span>') +
        (item.kids ? FOLDER : FILE) +
        '<span class="t-name">' + item.name + "</span>" +
        (item.fresh ? '<span class="t-tag">Quorum</span>' : "");
      rows[item.id || item.name] = row;
      if (item.fresh) {
        var wrap = document.createElement("div");
        wrap.className = "t-fresh";
        var inner = document.createElement("div");
        inner.appendChild(row);
        wrap.appendChild(inner);
        parent.appendChild(wrap);
        rows.freshWrap = wrap;
      } else {
        parent.appendChild(row);
      }
      if (item.kids) {
        var kids = document.createElement("div");
        kids.className = "t-kids";
        var box = document.createElement("div");
        build(item.kids, depth + 1, box);
        kids.appendChild(box);
        parent.appendChild(kids);
        row.kids = kids;
      }
    });
  }
  build(TREE, 0, list);

  var cursor = document.createElement("div");
  cursor.className = "t-cursor";
  cursor.innerHTML = '<svg viewBox="0 0 16 16"><path d="M2 1.5l11 6.2-4.6 1.1 2.6 5-1.9.9-2.6-5L3 12.5z" fill="#fff" stroke="#0b1530" stroke-width="1" stroke-linejoin="round"/></svg>';
  root.appendChild(list);
  root.appendChild(cursor);

  function open(name, on) { rows[name].classList.toggle("open", on); rows[name].kids.classList.toggle("open", on); }
  function select(name) {
    Object.keys(rows).forEach(function (k) { if (rows[k].classList) rows[k].classList.remove("active"); });
    if (name) rows[name].classList.add("active");
  }

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    open("meetings", true);
    rows.freshWrap.classList.add("show");
    select("new");
    cursor.remove();
    return;
  }

  var visible = false;
  var waiters = [];
  new IntersectionObserver(function (entries) {
    visible = entries[0].isIntersecting;
    if (visible) { waiters.forEach(function (w) { w(); }); waiters = []; }
  }).observe(root);

  function sleep(ms) {
    return new Promise(function (done) { setTimeout(done, ms); }).then(function () {
      return visible ? null : new Promise(function (done) { waiters.push(done); });
    });
  }

  // The cursor sits inside the scrolling frame, so its coordinates include the scroll offset.
  function moveTo(name) {
    var row = rows[name].getBoundingClientRect();
    var frame = root.getBoundingClientRect();
    var x = row.left - frame.left + 34 + Math.min(row.width * 0.25, 90);
    var y = row.top - frame.top + root.scrollTop + row.height / 2 - 2;
    cursor.style.transform = "translate(" + x + "px," + y + "px)";
    return sleep(650);
  }
  function click() {
    cursor.classList.add("press");
    return sleep(140).then(function () { cursor.classList.remove("press"); return sleep(120); });
  }
  function scrollTo(name) {
    var row = rows[name];
    var top = row.offsetTop - root.clientHeight / 2 + row.offsetHeight / 2;
    root.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    return sleep(700);
  }

  function loop() {
    return sleep(900)
      .then(function () { return moveTo("meetings"); })
      .then(click)
      .then(function () { open("meetings", true); return sleep(700); })
      .then(function () { return moveTo("review"); })
      .then(click)
      .then(function () { select("review"); return sleep(1100); })
      .then(function () { rows.freshWrap.classList.add("show"); return sleep(1300); })
      .then(function () { return moveTo("new"); })
      .then(click)
      .then(function () { select("new"); return sleep(1200); })
      .then(function () { return scrollTo("projects"); })
      .then(function () { return moveTo("projects"); })
      .then(click)
      .then(function () { open("projects", true); return sleep(700); })
      .then(function () { return scrollTo("launch"); })
      .then(function () { return moveTo("launch"); })
      .then(click)
      .then(function () { select("launch"); return sleep(1400); })
      .then(function () { return moveTo("projects"); })
      .then(click)
      .then(function () { open("projects", false); select(null); return sleep(600); })
      .then(function () { return scrollTo("CLAUDE.md"); })
      .then(function () { return moveTo("meetings"); })
      .then(click)
      .then(function () { open("meetings", false); rows.freshWrap.classList.remove("show"); return sleep(900); })
      .then(loop);
  }
  loop();
})();
