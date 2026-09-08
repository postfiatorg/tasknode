/* Shared, dependency-free appearance store. Runs before the first app paint. */
(function () {
  "use strict";
  if (window.tasknodeAppearance) return;
  var key = "tasknode.appearance.v1";
  var listeners = new Set();
  var media = null;
  try { media = window.matchMedia("(prefers-color-scheme: dark)"); } catch { /* Light fallback. */ }
  function normalize(value) { return value === "light" || value === "dark" ? value : "system"; }
  function read() {
    try { return { preference: normalize(window.localStorage.getItem(key)), sessionOnly: false }; }
    catch { return { preference: "system", sessionOnly: true }; }
  }
  var initial = read();
  var snapshot;
  function apply(preference, sessionOnly) {
    var resolved = preference === "system" ? (media && media.matches ? "dark" : "light") : preference;
    if (snapshot && snapshot.preference === preference && snapshot.resolved === resolved && snapshot.sessionOnly === sessionOnly) return;
    snapshot = Object.freeze({ preference: preference, resolved: resolved, sessionOnly: sessionOnly });
    var root = document.documentElement;
    root.dataset.theme = resolved;
    root.dataset.themePreference = preference;
    root.style.colorScheme = resolved;
    // Also covers the interval before the application stylesheet arrives.
    root.style.backgroundColor = resolved === "dark" ? "#171816" : "#faf9f6";
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = resolved === "dark" ? "#171816" : "#faf9f6";
    listeners.forEach(function (listener) { listener(); });
  }
  function systemChanged() { apply(snapshot.preference, snapshot.sessionOnly); }
  function storageChanged(event) {
    if (event.key !== key && event.key !== null) return;
    // Ignore sessionStorage events; storageArea may be inaccessible in privacy mode.
    try { if (event.storageArea && event.storageArea !== window.localStorage) return; } catch { return; }
    apply(normalize(event.newValue), false);
  }
  function connect() {
    if (media && media.addEventListener) media.addEventListener("change", systemChanged);
    else if (media && media.addListener) media.addListener(systemChanged);
    window.addEventListener("storage", storageChanged);
    if (snapshot.sessionOnly) systemChanged();
    else { var current = read(); apply(current.preference, current.sessionOnly); }
  }
  function disconnect() {
    if (media && media.removeEventListener) media.removeEventListener("change", systemChanged);
    else if (media && media.removeListener) media.removeListener(systemChanged);
    window.removeEventListener("storage", storageChanged);
  }
  apply(initial.preference, initial.sessionOnly);
  window.tasknodeAppearance = Object.freeze({
    getSnapshot: function () { return snapshot; },
    setPreference: function (value) {
      var preference = normalize(value);
      var sessionOnly = false;
      try { window.localStorage.setItem(key, preference); } catch { sessionOnly = true; }
      apply(preference, sessionOnly);
    },
    subscribe: function (listener) {
      listeners.add(listener);
      if (listeners.size === 1) connect();
      return function () { listeners.delete(listener); if (!listeners.size) disconnect(); };
    }
  });
}());
