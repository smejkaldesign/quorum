(function () {
  // Features not live yet (see the launch switches in each page's head) lose their links.
  document.querySelectorAll("[data-launch]").forEach(function (el) {
    if (!document.documentElement.classList.contains("pre-" + el.dataset.launch)) return;
    el.removeAttribute("href");
    el.setAttribute("aria-disabled", "true");
    el.setAttribute("title", "Available at launch");
  });

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

  // Contact modal. FormSubmit emails each post to the address in the URL; the
  // first post sends that inbox a one-time activation link.
  var CONTACT_ENDPOINT = "https://formsubmit.co/ajax/eric@smejkal.design";
  var dialog = document.getElementById("contact");
  if (dialog && dialog.showModal) {
    var form = dialog.querySelector("form");
    var status = dialog.querySelector(".contact-status");
    var send = form.querySelector('[type="submit"]');
    var setStatus = function (text, kind) {
      status.textContent = text;
      status.className = "contact-status" + (kind ? " " + kind : "");
    };
    document.querySelectorAll("[data-contact-open]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setStatus("");
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
  }

  var capture = document.querySelector("form.capture");
  if (capture) {
    capture.addEventListener("submit", function (event) {
      event.preventDefault();
    });
  }
})();
