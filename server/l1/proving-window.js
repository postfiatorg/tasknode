// The daily proving window. Proofs for Solana deposits and for both withdrawal paths are made
// only while one proving session runs, so these routes are closed outside it. The hours are an
// operator setting, L1_PROVING_WINDOW_UTC=HH:MM-HH:MM (UTC, opening before closing on one day).
// Unset or malformed: no window is announced and the screens behave as before.
const SETTING = /^([01][0-9]|2[0-3]):([0-5][0-9])-([01][0-9]|2[0-3]):([0-5][0-9])$/;

export function parseProvingWindow(value) {
  const match = typeof value === "string" ? SETTING.exec(value.trim()) : null;
  if (!match) return null;
  const open = Number(match[1]) * 60 + Number(match[2]);
  const close = Number(match[3]) * 60 + Number(match[4]);
  // A window that crosses midnight, or is empty, is refused rather than guessed.
  if (close <= open) return null;
  return { opens_utc: `${match[1]}:${match[2]}`, closes_utc: `${match[3]}:${match[4]}`, open_minute: open, close_minute: close };
}

// The readiness answers of the three screens carry the window and this server's clock, so the
// countdown does not depend on the browser's clock.
export const PROVING_WINDOW_PATHS = new Set(["/solana/readiness", "/withdrawals/readiness", "/solana/withdrawals/readiness"]);

export function withProvingWindow(payload, env = process.env, now = Date.now) {
  const window = parseProvingWindow(env.L1_PROVING_WINDOW_UTC);
  if (!window || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return { ...payload, proving_window: { ...window, now_unix_ms: now() } };
}
