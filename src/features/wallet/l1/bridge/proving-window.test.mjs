import test from "node:test";
import assert from "node:assert/strict";
import { provingWindowText, waitText } from "./proving-window.js";

const at = (hour, minute) => ({ opens_utc: "17:00", closes_utc: "19:00", open_minute: 1020, close_minute: 1140,
  now_unix_ms: Date.UTC(2026, 10, 26, hour, minute) });
const zagreb = { timeZone: "Europe/Zagreb" };
const SCREENS = [["deposit", "Deposits are"], ["withdrawal", "Withdrawals are"]];

test("closed outside the window: the daily hours, local hours and the time to the next opening", () => {
  for (const [kind, what] of SCREENS) {
    assert.equal(provingWindowText(at(10, 0), { kind, open: false, ...zagreb }),
      `${what} open every day from 17:00 to 19:00 UTC (18:00 to 20:00 your time). Next opening in 7 hours. Your funds are safe in the meantime.`);
  }
  assert.equal(provingWindowText(at(16, 59), { kind: "deposit", open: false, ...zagreb }),
    "Deposits are open every day from 17:00 to 19:00 UTC (18:00 to 20:00 your time). Next opening in 1 minute. Your funds are safe in the meantime.");
  // At closing the window is over; the next one is tomorrow.
  assert.match(provingWindowText(at(19, 0), { kind: "withdrawal", open: false, ...zagreb }), /Next opening in 22 hours\. /);
  assert.match(provingWindowText(at(20, 15), { kind: "withdrawal", open: false, ...zagreb }), /Next opening in 20 hours 45 minutes\. /);
});

test("open inside the window: until when, in UTC and local time", () => {
  for (const [kind] of SCREENS) {
    for (const [hour, minute] of [[17, 0], [17, 30], [18, 59]]) {
      assert.equal(provingWindowText(at(hour, minute), { kind, open: true, ...zagreb }), "Open now until 19:00 UTC (20:00 your time).");
    }
  }
  // Open outside the announced hours promises nothing.
  assert.equal(provingWindowText(at(19, 0), { kind: "deposit", open: true, ...zagreb }), "");
  assert.equal(provingWindowText(at(10, 0), { kind: "withdrawal", open: true, ...zagreb }), "");
});

test("closed inside the window: no opening time is promised", () => {
  for (const [kind] of SCREENS) {
    for (const [hour, minute] of [[17, 0], [17, 30], [18, 59]]) {
      assert.equal(provingWindowText(at(hour, minute), { kind, open: false, ...zagreb }),
        "This should be open now and is not. Nothing is lost; please try again later today or tomorrow from 17:00 UTC.");
    }
  }
});

test("no window, or a malformed one, adds no text", () => {
  for (const window of [undefined, null, {}, { ...at(10, 0), open_minute: 1200 }, { ...at(10, 0), now_unix_ms: "now" }, { ...at(10, 0), opens_utc: "5pm" }]) {
    assert.equal(provingWindowText(window, { kind: "deposit", open: false }), "");
  }
});

test("local hours follow the reader's time zone, including summer time", () => {
  const july = { ...at(10, 0), now_unix_ms: Date.UTC(2026, 6, 1, 10, 0) };
  assert.match(provingWindowText(july, { kind: "deposit", open: false, ...zagreb }), /\(19:00 to 21:00 your time\)/);
  assert.match(provingWindowText(at(10, 0), { kind: "deposit", open: false, timeZone: "UTC" }), /\(17:00 to 19:00 your time\)/);
});

test("waiting time in words", () => {
  assert.equal(waitText(1), "1 minute");
  assert.equal(waitText(59), "59 minutes");
  assert.equal(waitText(60), "1 hour");
  assert.equal(waitText(61), "1 hour 1 minute");
  assert.equal(waitText(1439), "23 hours 59 minutes");
});

test("local hours are those of the occurrence the sentence names, across both summer-time changes", () => {
  const window = (ms) => ({ ...at(10, 0), now_unix_ms: ms });
  // 28 March 2026 after closing: tomorrow's window is in summer time (19:00 to 21:00 in Zagreb).
  assert.match(provingWindowText(window(Date.UTC(2026, 2, 28, 19, 0)), { kind: "withdrawal", open: false, ...zagreb }),
    /\(19:00 to 21:00 your time\)\. Next opening in 22 hours\./);
  // Before opening on 28 March: today's window, still in winter time.
  assert.match(provingWindowText(window(Date.UTC(2026, 2, 28, 16, 59)), { kind: "withdrawal", open: false, ...zagreb }), /\(18:00 to 20:00 your time\)/);
  // 24 October 2026 after closing: tomorrow's window is back in winter time (18:00 to 20:00).
  assert.match(provingWindowText(window(Date.UTC(2026, 9, 24, 19, 0)), { kind: "deposit", open: false, ...zagreb }), /\(18:00 to 20:00 your time\)/);
  // While open, the closing is today's closing instant.
  assert.equal(provingWindowText(window(Date.UTC(2026, 2, 28, 18, 59)), { kind: "deposit", open: true, ...zagreb }), "Open now until 19:00 UTC (20:00 your time).");
  // A window whose endpoints straddle the change (00:30 to 01:30 UTC on 29 March; Zagreb moves at 01:00 UTC):
  // each endpoint is formatted from its own instant.
  const night = { opens_utc: "00:30", closes_utc: "01:30", open_minute: 30, close_minute: 90, now_unix_ms: Date.UTC(2026, 2, 28, 22, 0) };
  assert.match(provingWindowText(night, { kind: "deposit", open: false, ...zagreb }), /\(01:30 to 03:30 your time\)\. Next opening in 2 hours 30 minutes\./);
});
