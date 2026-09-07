// Mechanical text/JSON utilities for inference paths. No regular expressions.
import { isWhitespace, isAsciiDigit, isAsciiLetter, isIdentifierChar, isHex, textTokens, splitWhitespace, collapseWhitespace } from "../shared/text-protocol.js";
export { isWhitespace, isAsciiDigit, isAsciiLetter, isIdentifierChar, isHex, textTokens, splitWhitespace, collapseWhitespace };

export function markdownHeading(value = "") {
  const text = String(value || "");
  let index = 0;
  while (text[index] === "#") index += 1;
  return index >= 1 && index <= 6 && isWhitespace(text[index]) ? text.slice(index).trim() : "";
}

export function limitNewlines(value = "", max = 2) {
  let count = 0;
  let result = "";
  for (const char of String(value || "")) {
    count = char === "\n" ? count + 1 : 0;
    if (count <= max) result += char;
  }
  return result;
}

export function stripMarkdownFence(value = "") {
  const text = String(value || "").trim();
  if (!text.startsWith("```") || !text.endsWith("```")) return text;
  const newline = text.indexOf("\n");
  if (newline < 0) return text;
  const language = text.slice(3, newline).trim().toLowerCase();
  if (!["", "json", "markdown", "md"].includes(language)) return text;
  return text.slice(newline + 1, -3).trim();
}

export function parseInferenceJson(value = "") {
  const parsed = JSON.parse(stripMarkdownFence(value));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError("Expected a JSON object");
  return parsed;
}

export function stripBullet(value = "") {
  const text = String(value || "").trim();
  return ["-", "*"].includes(text[0]) && isWhitespace(text[1]) ? text.slice(1).trimStart() : text;
}

export function replaceIdentifier(value = "", identifier, replacement) {
  const text = String(value || "");
  let result = "";
  let cursor = 0;
  for (const token of textTokens(text)) {
    if (token.value !== identifier) continue;
    result += text.slice(cursor, token.start) + replacement;
    cursor = token.end;
  }
  return result + text.slice(cursor);
}

export function renderTextTemplate(value = "", variables = {}) {
  const text = String(value || "");
  let result = "";
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("{{", cursor);
    if (start < 0) return result + text.slice(cursor);
    const end = text.indexOf("}}", start + 2);
    if (end < 0) return result + text.slice(cursor);
    const key = text.slice(start + 2, end);
    result += text.slice(cursor, start) + (Object.hasOwn(variables, key) ? String(variables[key] ?? "") : "");
    cursor = end + 2;
  }
  return result;
}

const secretFields = new Set(["seed_phrase", "recovery_phrase", "mnemonic", "private_key", "password", "api_key", "access_token", "oauth_token", "secret", "token"]);
function secretField(name) {
  const normalized = collapseWhitespace(String(name || "").toLowerCase()).split(" ").join("_");
  return secretFields.has(normalized) || ["_key", "_token", "_secret", "_seed", "_password"].some((suffix) => normalized.endsWith(suffix));
}

function scrubObject(value) {
  if (Array.isArray(value)) return value.map(scrubObject);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, secretField(key) ? "[redacted]" : scrubObject(entry)]));
  return typeof value === "string" ? redactTextTokens(value) : value;
}

function sensitiveToken(token) {
  const bare = token.startsWith("0x") ? token.slice(2) : token;
  if (bare.length >= 64 && isHex(bare)) return true;
  if (["sk-", "ak-", "ghp_", "gho_", "github_pat_", "xoxb_"].some((prefix) => token.startsWith(prefix) && token.length >= prefix.length + 8)) return true;
  if (token.startsWith("s") && token.length >= 29 && [...token].every((char) => isAsciiLetter(char) || isAsciiDigit(char))) return true;
  if (["postgres:", "postgresql:", "mysql:", "redis:", "amqp:", "mongodb:"].some((prefix) => token.toLowerCase().startsWith(prefix))) return true;
  const ip = token.split(":")[0].split(".");
  return ip.length === 4 && ip.every((part) => part.length > 0 && [...part].every(isAsciiDigit) && Number(part) <= 255);
}

function redactTextTokens(value) {
  const text = String(value || "");
  let result = "";
  let cursor = 0;
  for (const token of textTokens(text, (char) => !isWhitespace(char) && !['"', "'", "`", ",", ";", "(", ")", "[", "]", "{", "}"].includes(char))) {
    if (!sensitiveToken(token.value)) continue;
    result += text.slice(cursor, token.start) + "[redacted]";
    cursor = token.end;
  }
  return result + text.slice(cursor);
}

export function redactSecrets(value = "") {
  const text = String(value || "");
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return JSON.stringify(scrubObject(parsed));
  } catch { /* Plain text uses mechanical field/token parsing below. */ }
  return text.split("\n").map((line) => {
    const lower = line.toLowerCase();
    for (const separator of ["=", ":"]) {
      const index = line.indexOf(separator);
      if (index < 0) continue;
      const label = lower.slice(0, index).trim();
      if (secretField(label) || [...secretFields].some((field) => label.endsWith(field.split("_").join(" ")))) return `${line.slice(0, index + 1)} [redacted]`;
    }
    return redactTextTokens(line);
  }).join("\n");
}

export function sensitiveSourceTokens(value = "") {
  return new Set(textTokens(String(value || "").toLowerCase()).map((token) => token.value)
    .filter((token) => token.length >= 8 && [...token].some((char) => isAsciiDigit(char) || char === "_" || char === "-")));
}

export function replaceSensitiveSourceTokens(value = "", source = "") {
  const identifiers = sensitiveSourceTokens(source);
  const text = String(value || "");
  let result = "";
  let cursor = 0;
  for (const token of textTokens(text)) {
    if (!identifiers.has(token.value.toLowerCase())) continue;
    result += text.slice(cursor, token.start) + "private reference";
    cursor = token.end;
  }
  return collapseWhitespace(result + text.slice(cursor));
}

export function hasPrivateLiterals(value = "") {
  const text = String(value || "").toLowerCase();
  if (text.includes("https:") || text.includes("http:")) return true;
  if (textTokens(text, (char) => isAsciiLetter(char) || isAsciiDigit(char) || char === "_").some((token) => text[token.start - 1] === "@" || (token.value.length >= 32 && isHex(token.value)))) return true;
  for (let i = 0; i < text.length; i += 1) {
    if (text.startsWith("0x", i)) {
      let end = i + 2;
      while (end < text.length && isHex(text[end])) end += 1;
      if (end - i >= 10) return true;
    }
    if (!isAsciiDigit(text[i]) || isIdentifierChar(text[i - 1])) continue;
    let end = i;
    while (isAsciiDigit(text[end])) end += 1;
    if (text[end] === "." && isAsciiDigit(text[end + 1])) {
      end += 1;
      while (isAsciiDigit(text[end])) end += 1;
    }
    while (isWhitespace(text[end])) end += 1;
    if (["pft", "usd", "btc", "eth"].some((currency) => text.startsWith(currency, end) && !isIdentifierChar(text[end + currency.length]))) return true;
  }
  return false;
}

export function extractHttpLinks(value = "") {
  const text = String(value || "");
  const links = [];
  for (let i = 0; i < text.length; i += 1) {
    if (!text.startsWith("https://", i) && !text.startsWith("http://", i)) continue;
    let end = i;
    while (end < text.length && !isWhitespace(text[end]) && ![")", ">", "]", '"', "'"].includes(text[end])) end += 1;
    let link = text.slice(i, end);
    while ([".", ",", ";", ":"].includes(link.at(-1))) link = link.slice(0, -1);
    try { const url = new URL(link); if (url.hostname) links.push(link); } catch { /* Invalid URL is not a citation. */ }
    i = end - 1;
  }
  return [...new Set(links)];
}

// Replace classifier-provided spans, allowing whitespace and case variation.
export function replaceClassifiedSpan(value = "", span = "", replacement = "") {
  const text = String(value || "");
  const needle = String(span || "").trim().toLowerCase();
  if (!needle) return text;
  let out = "";
  for (let start = 0; start < text.length;) {
    let end = start;
    let n = 0;
    while (n < needle.length && end < text.length) {
      if (isWhitespace(needle[n]) && isWhitespace(text[end])) {
        while (n < needle.length && isWhitespace(needle[n])) n += 1;
        while (end < text.length && isWhitespace(text[end])) end += 1;
      } else if (needle[n] === text[end].toLowerCase()) { n += 1; end += 1; }
      else break;
    }
    if (n === needle.length) { out += replacement; start = end; }
    else { out += text[start]; start += 1; }
  }
  return out;
}
