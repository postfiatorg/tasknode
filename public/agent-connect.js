/* Copy buttons on /connect and /activate (inline scripts are blocked by CSP). */
(function () {
  document.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest("[data-copy]");
    if (!button || !navigator.clipboard) return;
    navigator.clipboard.writeText(button.getAttribute("data-copy")).then(function () {
      var label = button.textContent;
      button.textContent = "Copied";
      setTimeout(function () { button.textContent = label; }, 1400);
    });
  });
}());
