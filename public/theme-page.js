/* Own theme listeners for standalone auth pages, including back/forward cache. */
(function () {
  var unsubscribe;
  function connect() {
    if (!unsubscribe && window.tasknodeAppearance) unsubscribe = window.tasknodeAppearance.subscribe(function () {});
  }
  window.addEventListener("pageshow", connect);
  window.addEventListener("pagehide", function () { if (unsubscribe) unsubscribe(); unsubscribe = null; });
  connect();
}());
