// Launch switches. Off: the feature's links are disabled on the deployed site
// (script.js). Local always runs everything; add ?prelaunch to preview the deployed state.
(function () {
  var ready = { download: true, github: true };
  var local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && !/[?&]prelaunch\b/.test(location.search);
  if (local) return;
  for (var k in ready) if (!ready[k]) document.documentElement.classList.add("pre-" + k);
})();
