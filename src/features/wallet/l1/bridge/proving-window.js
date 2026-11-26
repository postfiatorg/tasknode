// Plain-language hours of the daily proving window, the same on the deposit and withdrawal screens.
// The window and the clock come from the server's readiness answer (`proving_window`); only the
// local rendering of the hours uses the browser's time zone.
const DAY = 24 * 60;

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

// The occurrence of the window that a sentence at nowMs talks about: today's until its closing,
// tomorrow's after it. Each endpoint is its own instant.
function occurrence(window, nowMs) {
  const day = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const open = day + window.open_minute * 60_000, close = day + window.close_minute * 60_000;
  return nowMs >= close ? { open: open + 86_400_000, close: close + 86_400_000 } : { open, close };
}

function localTime(instant, timeZone) {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone && { timeZone }) })
    .format(new Date(instant));
}

// Where the server's clock stands against the window: minutes since midnight UTC, whether it is
// inside, and the whole minutes until the next opening (rounded up).
export function windowPosition(window) {
  const minuteMs = (window.now_unix_ms % 86_400_000 + 86_400_000) % 86_400_000;
  const minute = Math.floor(minuteMs / 60_000);
  const inside = minute >= window.open_minute && minute < window.close_minute;
  const untilOpen = ((window.open_minute * 60_000 - minuteMs) % 86_400_000 + 86_400_000) % 86_400_000;
  return { inside, untilOpenMinutes: Math.ceil(untilOpen / 60_000) };
}

// kind: "deposit" or "withdrawal"; open: the route reports ready. Empty when no window is set.
export function provingWindowText(window, { kind, open, timeZone } = {}) {
  if (!validWindow(window)) return "";
  const { inside, untilOpenMinutes } = windowPosition(window);
  const { open: opens, close: closes } = occurrence(window, window.now_unix_ms);
  if (open) return inside ? `Open now until ${window.closes_utc} UTC (${localTime(closes, timeZone)} your time).` : "";
  if (inside) return `This should be open now and is not. Nothing is lost; please try again later today or tomorrow from ${window.opens_utc} UTC.`;
  const what = kind === "deposit" ? "Deposits are" : "Withdrawals are";
  return `${what} open every day from ${window.opens_utc} to ${window.closes_utc} UTC (${localTime(opens, timeZone)} to ${localTime(closes, timeZone)} your time). `
    + `Next opening in ${waitText(untilOpenMinutes)}. Your funds are safe in the meantime.`;
}
