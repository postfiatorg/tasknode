// Plain-language hours of the daily proving window, the same on the deposit and withdrawal screens.
// The window and the clock come from the server's readiness answer (`proving_window`); only the
// local rendering of the hours uses the browser's time zone.
const DAY = 24 * 60;
const DAY_MS = 86_400_000;
// An answer that says "open" is not repeated once it is older than this without a fresh one.
export const STALE_MS = 10 * 60_000;

function validWindow(window) {
  return window && Number.isInteger(window.open_minute) && Number.isInteger(window.close_minute)
    && window.open_minute >= 0 && window.open_minute < window.close_minute && window.close_minute <= DAY
    && Number.isFinite(window.now_unix_ms) && /^\d\d:\d\d$/.test(window.opens_utc ?? "") && /^\d\d:\d\d$/.test(window.closes_utc ?? "");
}

function plural(count, word) { return `${count} ${word}${count === 1 ? "" : "s"}`; }

export function waitText(minutes) {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (!hours) return plural(rest, "minute");
  return rest ? `${plural(hours, "hour")} ${plural(rest, "minute")}` : plural(hours, "hour");
}

// A monotonic browser clock: the server's time is anchored to it when an answer arrives.
export function monotonicNow() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

// A readiness answer as stored by a screen: the answer and the monotonic time it arrived.
export function received(answer, at = monotonicNow()) {
  return answer && typeof answer === "object" ? { ...answer, received_at: at } : answer;
}
export const readinessAnswer = received;
// A refused readiness request. An answer from the server, even a refusal, carries its own window
// (or none). A failed read with no answer keeps the last good window and its clock, marked unknown,
// so the hours and the countdown stay and only the claim that the route is open goes.
export function readinessRefusal(failure, message, at = monotonicNow(), previous) {
  if (failure?.payload || !previous?.proving_window) return received({ ready: false, message, proving_window: failure?.payload?.proving_window }, at);
  return { ready: false, message, proving_window: previous.proving_window, received_at: previous.received_at, unknown: true };
}

// The server's time now: its clock in the answer plus the monotonic time since the answer arrived.
function serverNow(window, receivedAt, at) {
  return window.now_unix_ms + (Number.isFinite(receivedAt) && Number.isFinite(at) ? Math.max(0, at - receivedAt) : 0);
}

// The occurrence of the window that a sentence at nowMs talks about: today's until its closing,
// tomorrow's after it. Each endpoint is its own instant.
function occurrence(window, nowMs) {
  const day = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const open = day + window.open_minute * 60_000, close = day + window.close_minute * 60_000;
  return nowMs >= close ? { open: open + DAY_MS, close: close + DAY_MS } : { open, close };
}

function localTime(instant, timeZone) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone && { timeZone }) })
    .format(new Date(instant));
}

// Where the server's clock stands against the window: whether it is inside, and the whole minutes
// until the next opening (rounded up).
export function windowPosition(window, nowMs = window.now_unix_ms) {
  const { open, close } = occurrence(window, nowMs);
  const inside = nowMs >= open && nowMs < close;
  const untilOpen = nowMs < open ? open - nowMs : open + DAY_MS - nowMs;
  return { inside, untilOpenMinutes: Math.ceil(untilOpen / 60_000) };
}

// Milliseconds until the next opening, or until the closing while inside; null without a window.
export function msUntilBoundary(window, nowMs = window?.now_unix_ms) {
  if (!validWindow(window)) return null;
  const { open, close } = occurrence(window, nowMs);
  return nowMs < open ? open - nowMs : close - nowMs;
}

// The monotonic time at which an answer stops permitting a withdrawal: the window's next boundary
// or the freshness limit, whichever is first, counted from `started`, when its request started, so
// the time spent delivering or processing the answer never extends it; never without a window.
export function answerExpiry(window, started) {
  const boundary = msUntilBoundary(window);
  return boundary === null || !Number.isFinite(started) ? Infinity : started + Math.min(boundary, STALE_MS);
}
// Said when a burn's readiness answer expired before the burn left; nothing was sent.
export const EXPIRED = "The withdrawal's availability answer expired before the burn was sent, so nothing was burned: review the withdrawal again.";

// kind: "deposit" or "withdrawal"; open: the route reports ready; unknown: the last read failed;
// nowMs: the server's time now; ageMs: how old the answer is. Empty when no window is set.
export function provingWindowText(window, { kind, open, unknown = false, timeZone, nowMs, ageMs = 0 } = {}) {
  if (!validWindow(window)) return "";
  const now = Number.isFinite(nowMs) ? nowMs : window.now_unix_ms;
  const { inside, untilOpenMinutes } = windowPosition(window, now);
  const { open: opens, close: closes } = occurrence(window, now);
  if (open) return inside && ageMs <= STALE_MS ? `Open now until ${window.closes_utc} UTC (${localTime(closes, timeZone)} your time).` : "";
  if (inside && unknown) return "";
  if (inside) return `This should be open now and is not. Nothing is lost; please try again later today or tomorrow from ${window.opens_utc} UTC.`;
  const what = kind === "deposit" ? "Deposits are" : "Withdrawals are";
  return `${what} open every day from ${window.opens_utc} to ${window.closes_utc} UTC (${localTime(opens, timeZone)} to ${localTime(closes, timeZone)} your time). `
    + `Next opening in ${waitText(untilOpenMinutes)}. Your funds are safe in the meantime.`;
}

// The text for a stored answer that arrived at receivedAt, read at the monotonic time at.
export function windowTextAt(window, { receivedAt, at = monotonicNow(), ...options } = {}) {
  if (!validWindow(window)) return "";
  const age = Number.isFinite(receivedAt) ? Math.max(0, at - receivedAt) : 0;
  return provingWindowText(window, { ...options, nowMs: serverNow(window, receivedAt, at), ageMs: age });
}

// One screen's readiness requests, numbered when they are made; Review and Confirm take theirs with
// begin(), which also supersedes every earlier Review or Confirm. apply(n, carries, open) is the one
// decision every write of request n's completion goes through: it may write unless an answer of a
// newer request has already been applied; an applied answer that does not allow a withdrawal
// (open === false) is remembered. current(n, carries) is the same rule for an operation after each
// of its later awaits: it may go on unless a newer operation began or an answer newer than its own
// said closed (a still newer open answer does not bring it back). The order is consulted only once
// the window is involved: this screen has applied an answer with a window (and stays so after a
// later answer removes it), or this answer carries one. A screen that never receives a window
// therefore applies every completion and continues every operation, as before the window existed.
export function readinessOrder() {
  let made = 0, applied = 0, closed = 0, operation = 0, seen = false;
  return {
    next: () => ++made,
    begin: () => (operation = ++made),
    get seen() { return seen; },
    apply(n, carries = false, open) {
      if ((seen || carries) && n < applied) return false;
      if (carries) seen = true;
      if (n > applied) applied = n;
      if (open === false && n > closed) closed = n;
      return true;
    },
    current(n, carries = false) { return !(seen || carries) || (n >= operation && n >= closed); },
  };
}
