// Display-only number and identifier formatting for the L1 wallet. Exact BigInt
// arithmetic; nothing here rounds a value that is later signed or submitted.
const TEN = 10n;

function toBigInt(value) {
  if (value === null || value === undefined || value === "") return null;
  try { return BigInt(value); } catch { return null; }
}

function group(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Atoms -> "1,234.50". Trailing zeros are trimmed down to `min` decimals; never rounds.
export function amount(atoms, { precision = 6, min = 2, max = precision, sign = false } = {}) {
  const value = toBigInt(atoms);
  if (value === null) return "—";
  const negative = value < 0n, abs = negative ? -value : value;
  const scale = TEN ** BigInt(precision);
  const whole = abs / scale;
  let fraction = String(abs % scale).padStart(precision, "0");
  const keep = Math.min(Math.max(min, 0), precision);
  // Trim zeros past `keep`; if more digits than `max` remain, cut (display only).
  fraction = fraction.replace(/0+$/, "");
  if (fraction.length < keep) fraction = fraction.padEnd(keep, "0");
  if (fraction.length > max) fraction = fraction.slice(0, max);
  const prefix = negative ? "−" : sign && value > 0n ? "+" : "";
  return `${prefix}${group(String(whole))}${fraction ? `.${fraction}` : ""}`;
}

// Split for typography: whole part and fractional part rendered separately.
export function amountParts(atoms, options) {
  const text = amount(atoms, options);
  const dot = text.indexOf(".");
  return dot < 0 ? [text, ""] : [text.slice(0, dot), text.slice(dot)];
}

// Value at NAV: atoms * navAtoms / 1e6, exact floor in atoms.
export function valueAt(atoms, priceAtoms, precision = 6) {
  const a = toBigInt(atoms), p = toBigInt(priceAtoms);
  if (a === null || p === null) return null;
  return (a * p) / TEN ** BigInt(precision);
}

export function usd(atoms, options = {}) {
  const text = amount(atoms, { min: 2, max: 2, ...options });
  if (text === "—") return text;
  return text.startsWith("−") || text.startsWith("+") ? `${text[0]}$${text.slice(1)}` : `$${text}`;
}

// Basis points -> "0.20%".
export function percentFromBps(bps) {
  const value = Number(bps);
  if (!Number.isFinite(value)) return "—";
  return `${(value / 100).toFixed(2)}%`;
}

export function shortId(value, head = 6, tail = 4) {
  const text = String(value ?? "");
  if (!/^(pf|0x)?[0-9a-fA-F]{20,}$/.test(text)) return text;
  const prefix = text.startsWith("pf") || text.startsWith("0x") ? text.slice(0, 2) : "";
  const body = text.slice(prefix.length);
  return `${prefix}${body.slice(0, head)}…${body.slice(-tail)}`;
}

export function isLongId(value) {
  return /^(pf|0x)?[0-9a-fA-F]{20,}$/.test(String(value ?? ""));
}

export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rest = s % 60;
  if (m < 60) return `${m}m ${String(rest).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function dateTime(value) {
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}

// Price of one unit in the quote asset, in quote atoms (floor). Display only.
export function unitPrice(quoteAtoms, baseAtoms, precision = 6) {
  const q = toBigInt(quoteAtoms), b = toBigInt(baseAtoms);
  if (q === null || b === null || b === 0n) return null;
  return (q * TEN ** BigInt(precision)) / b;
}

// Plain-language wording for errors surfaced by lane models (presentation only).
export function plainError(message) {
  return String(message || "")
    .replace(/redemption reserve/gi, "cash-in reserve")
    .replace(/currently redeemable capacity/gi, "reserve available for cash-ins")
    .replace(/redeemable/gi, "available for cash-in")
    .replace(/Redemption facility/g, "Cash-in at NAV")
    .replace(/redemption facility/g, "cash-in at NAV")
    .replace(/Redemption/g, "Cash-in")
    .replace(/redemption/g, "cash-in")
    .replace(/Redeem/g, "Cash in")
    .replace(/redeem/g, "cash in");
}
