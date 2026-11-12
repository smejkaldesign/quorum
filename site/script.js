(function () {
  // Features not live yet (see the launch switches in each page's head) lose their links.
  document.querySelectorAll("[data-launch]").forEach(function (el) {
    if (!document.documentElement.classList.contains("pre-" + el.dataset.launch)) return;
    el.removeAttribute("href");
    el.setAttribute("aria-disabled", "true");
    el.setAttribute("title", "Available at launch");
  });

  // The Download buttons go straight to the newest open-source disk image. Its filename carries the version, so
  // the page asks GitHub for the latest release and picks the Mac DMG; if that fails, the release page opens.
  var DOWNLOAD_API = "https://api.github.com/repos/smejkaldesign/quorum/releases/latest";
  var downloads = Array.prototype.slice.call(document.querySelectorAll('[data-launch="download"][href]'));
  var dmgUrl = null;
  var resolveDmg = function () {
    if (dmgUrl) return Promise.resolve(dmgUrl);
    return fetch(DOWNLOAD_API, { headers: { Accept: "application/vnd.github+json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rel) {
        var asset = rel && (rel.assets || []).filter(function (a) { return /^Quorum-[0-9.]+-arm64\.dmg$/.test(a.name); })[0];
        dmgUrl = asset ? asset.browser_download_url : null;
        return dmgUrl;
      })
      .catch(function () { return null; });
  };
  if (downloads.length) {
    resolveDmg().then(function (u) { if (u) downloads.forEach(function (el) { el.href = u; }); });
    // The DMG downloads without the page changing, so a line under the buttons says it started.
    var started = function () {
      var note = document.querySelector("[data-download-note]");
      if (!note) return;
      note.textContent = "Your download started. Open the disk image and drag Quorum to Applications.";
      note.hidden = false;
    };
    downloads.forEach(function (el) {
      el.addEventListener("click", function (e) {
        if (dmgUrl) { started(); return; }
        e.preventDefault();
        resolveDmg().then(function (u) { window.location.href = u || el.href; if (u) started(); });
      });
    });
  }

  // "Join now" scrolls to the hero signup and puts the cursor in the email field.
  var focusJoin = function () {
    if (location.hash !== "#join") return;
    var email = document.getElementById("hero-email");
    if (email) setTimeout(function () { email.focus({ preventScroll: true }); }, 350);
  };
  window.addEventListener("hashchange", focusJoin);
  focusJoin();

  // The app preview is laid out at the app's default window width and scaled to the frame it sits in.
  var shot = document.querySelector("[data-app-preview]");
  if (shot) {
    var fit = function () { shot.style.setProperty("--s", String(shot.clientWidth / 1040)); };
    fit();
    if (window.ResizeObserver) new ResizeObserver(fit).observe(shot);
    else window.addEventListener("resize", fit);
  }

  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  // Contact form, in the modal on the home page and on /contact. FormSubmit emails each post to the address in
  // the URL; the first post sends that inbox a one-time activation link.
  var CONTACT_ENDPOINT = "https://formsubmit.co/ajax/eric@smejkal.design";
  function wireContact(form) {
    var status = form.querySelector(".contact-status");
    var send = form.querySelector('[type="submit"]');
    var setStatus = function (text, kind) {
      status.textContent = text;
      status.className = "contact-status" + (kind ? " " + kind : "");
    };
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var fields = [form.elements.name, form.elements.email, form.elements.message];
      var bad = fields.filter(function (f) { return !f.value.trim() || !f.checkValidity(); });
      fields.forEach(function (f) { f.setAttribute("aria-invalid", bad.indexOf(f) !== -1 ? "true" : "false"); });
      if (bad.length) {
        setStatus(bad[0] === form.elements.email && form.elements.email.value ? "Enter a valid email address." : "Fill in your name, email and question.", "error");
        bad[0].focus();
        return;
      }
      if (form.elements._honey.value) return;
      send.disabled = true;
      send.textContent = "Sending…";
      setStatus("");
      fetch(CONTACT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          name: form.elements.name.value.trim(),
          email: form.elements.email.value.trim(),
          message: form.elements.message.value.trim(),
          _subject: "Quorum site question from " + form.elements.name.value.trim(),
          _replyto: form.elements.email.value.trim(),
          _template: "table",
        }),
      })
        .then(function (res) { return res.json().then(function (body) { if (!res.ok || String(body.success) !== "true") throw new Error(); }); })
        .then(function () {
          form.reset();
          setStatus("Thanks. We will reply to you by email soon.", "ok");
        })
        .catch(function () {
          setStatus("That did not send. Try again, or email eric@smejkal.design.", "error");
        })
        .then(function () {
          send.disabled = false;
          send.textContent = "Send";
        });
    });
    return setStatus;
  }
  var dialog = document.getElementById("contact");
  if (dialog && dialog.showModal) {
    var form = dialog.querySelector("form");
    var setDialogStatus = wireContact(form);
    document.querySelectorAll("[data-contact-open]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setDialogStatus("");
        dialog.showModal();
        form.elements.name.focus();
      });
    });
    dialog.querySelectorAll("[data-contact-close]").forEach(function (btn) {
      btn.addEventListener("click", function () { dialog.close(); });
    });
    // a click on the backdrop lands on the dialog itself
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) dialog.close();
    });
  }
  var pageForm = document.querySelector("form.contact-form[data-contact-page]");
  if (pageForm) wireContact(pageForm);

  // Beta access: the email goes to the relay, which writes the request for the admin app; the code comes back by email
  var REQUEST_ENDPOINT = "https://relay.quorum.watch/v1/access-requests";
  document.querySelectorAll("form.capture").forEach(function (capture) {
    var note = document.getElementById(capture.getAttribute("aria-describedby"));
    var email = capture.elements.email;
    var submit = capture.querySelector('[type="submit"]');
    var label = submit.textContent;
    var source = capture.getAttribute("data-source") || "site";
    var say = function (text, kind) { if (!note) return; note.textContent = text; note.className = note.className.replace(/\b(ok|error)\b/g, "").trim() + (kind ? " " + kind : ""); };
    capture.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!email.value.trim() || !email.checkValidity()) { email.setAttribute("aria-invalid", "true"); say("Enter a valid email address.", "error"); email.focus(); return; }
      email.setAttribute("aria-invalid", "false");
      submit.disabled = true;
      submit.textContent = "Sending…";
      fetch(REQUEST_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: email.value.trim(), source: source, website: capture.elements.website ? capture.elements.website.value : "" }),
      })
        .then(function (res) { return res.json().then(function (body) { if (!res.ok || !body.ok) throw new Error(body.error || ""); return body; }); })
        .then(function (body) {
          capture.reset();
          say(body.already ? "You are already on the list. Your access code arrives by email once it is your turn." : "Thanks. Your access code arrives by email once it is your turn.", "ok");
        })
        .catch(function (err) {
          say(err && err.message ? err.message : "That did not send. Try again in a moment.", "error");
        })
        .then(function () {
          submit.disabled = false;
          submit.textContent = label;
        });
    });
  });
})();
