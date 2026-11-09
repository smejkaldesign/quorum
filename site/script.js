(function () {
  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  var capture = document.querySelector("form.capture");
  if (capture) {
    capture.addEventListener("submit", function (event) {
      event.preventDefault();
    });
  }
})();
