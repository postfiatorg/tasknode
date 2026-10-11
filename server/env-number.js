/**
 * NaN-safe numeric env reads.
 *
 * `Number("15s")` is NaN and Math.max/Math.min propagate NaN, so the idiom
 * `Math.max(5000, Number(process.env.X || 15000))` turned a mistyped value
 * into a NaN interval (setInterval fires every millisecond), a NaN timeout
 * (an immediate abort) or a NaN limit (no limit at all). These helpers return
 * the fallback for an unset, empty, non-numeric or non-finite value and then
 * clamp, which is what every call site already intended.
 */
export function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function envNumberAtLeast(name, fallback, minimum) {
  return Math.max(minimum, envNumber(name, fallback));
}

export function envNumberBetween(name, fallback, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, envNumber(name, fallback)));
}
