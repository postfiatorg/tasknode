/* Copy buttons on /connect and /activate (inline scripts are blocked by CSP). */
(function () {
  /* One-click prompt pairing: the sign-in link's fragment carries the agent's public key and a one-time secret.
     The fragment never reaches the server; keep it for Docs, which wraps the prompt library key once unlocked. */
  try {
    var match = /(?:^|[#&])p=([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})(?:&|$)/.exec(location.hash || "");
    var key = "tasknode.promptPairings";
    var pending = JSON.parse(localStorage.getItem(key) || "[]").filter(function (row) { return Date.now() - row.at < 86400000; });
    if (match) {
      pending = pending.filter(function (row) { return row.p !== match[1]; });
      pending.push({ p: match[1], s: match[2], at: Date.now() });
      history.replaceState(null, "", location.pathname + location.search);
    }
    localStorage.setItem(key, JSON.stringify(pending));
    var next = document.getElementById("prompt-pairing-next");
    if (next && pending.length) next.hidden = false;
  } catch (error) { /* storage unavailable: manual approval in Docs still works */ }

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
