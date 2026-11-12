import { SCALE } from "./constants.js";
export function atoms(value, label = "Amount") {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(String(value));
  if (!match) throw new Error(`${label} must be a positive decimal with at most six places`);
  const result = BigInt(match[1]) * SCALE + BigInt((match[2] || "").padEnd(6, "0"));
  if (result <= 0n) throw new Error(`${label} must be positive`);
  return safeInteger(result, label);
}
export function integer(value, label = "Value") {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error(`${label} is not an exact integer`);
  if (!/^[0-9]+$/.test(String(value))) throw new Error(`${label} is unavailable or invalid`);
  return BigInt(value);
}
export function safeInteger(value, label = "Value") {
  const exact = integer(value, label);
  if (exact > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds safe signing precision`);
  return Number(exact);
}
export function units(value) {
  if (value === undefined || value === null) return "Unavailable";
  const number = BigInt(value), sign = number < 0n ? "−" : "", abs = number < 0n ? -number : number;
  return `${sign}${abs / SCALE}.${String(abs % SCALE).padStart(6, "0")}`;
}
export function resultOf(response) {
  if (response?.error) throw new Error(response.error.message || "L1 read failed");
  return response?.result ?? response;
}
export function nonce() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
}
