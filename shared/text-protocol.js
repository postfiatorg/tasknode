export const isWhitespace = (char = "") => char.length > 0 && char.trim() === "";
export const isAsciiDigit = (char = "") => char >= "0" && char <= "9";
export const isAsciiLetter = (char = "") => (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");
export const isIdentifierChar = (char = "") => isAsciiLetter(char) || isAsciiDigit(char) || char === "_" || char === "-";
export const isHex = (text = "") => text.length > 0 && [...text.toLowerCase()].every((char) => isAsciiDigit(char) || (char >= "a" && char <= "f"));

export function textTokens(value = "", accepts = isIdentifierChar) {
  const text = String(value || "");
  const tokens = [];
  let start = -1;
  for (let i = 0; i <= text.length; i += 1) {
    if (i < text.length && accepts(text[i])) { if (start < 0) start = i; }
    else if (start >= 0) { tokens.push({ value: text.slice(start, i), start, end: i }); start = -1; }
  }
  return tokens;
}

export function splitWhitespace(value = "") {
  return textTokens(value, (char) => !isWhitespace(char)).map((token) => token.value);
}
export const collapseWhitespace = (value = "") => splitWhitespace(value).join(" ");

export function trimCharacters(value, characters, { start = true, end = true } = {}) {
  const text = String(value || "");
  let left = 0, right = text.length;
  if (start) while (left < right && characters.includes(text[left])) left += 1;
  if (end) while (right > left && characters.includes(text[right-1])) right -= 1;
  return text.slice(left,right);
}

export function replaceCharacterRuns(value, accepts, replacement) {
  let result = "", inRun = false;
  for (const char of String(value || "")) {
    if (accepts(char)) { if (!inRun) result += replacement; inRun = true; }
    else { result += char; inRun = false; }
  }
  return result;
}

export function normalizedHandle(value) {
  let text = trimCharacters(String(value || "").trim(), "@", { end: false }).toLowerCase();
  text = replaceCharacterRuns(text, char => !isIdentifierChar(char), "-");
  let result = "";
  for (let i=0;i<text.length;) {
    if (text[i] !== "-" && text[i] !== "_") { result += text[i++]; continue; }
    let end = i+1;
    while (text[end] === "-" || text[end] === "_") end += 1;
    result += end-i > 1 ? "-" : text[i]; i=end;
  }
  return trimCharacters(result, "-_");
}
export const storageIdentifier = value => trimCharacters(replaceCharacterRuns(value, char => !isIdentifierChar(char), "_"), "_");
export function stripPrefix(value, prefix, insensitive = false) {
  return (insensitive ? value.toLowerCase().startsWith(prefix.toLowerCase()) : value.startsWith(prefix)) ? value.slice(prefix.length) : value;
}
export const ipfsIdentifier = value => stripPrefix(stripPrefix(String(value || "").trim(), "ipfs://", true), "/ipfs/", true);
export const isDecimalDigits = value => typeof value === "string" && value.length > 0 && [...value].every(isAsciiDigit);
export const isHexLength = (value, length) => typeof value === "string" && value.length === length && isHex(value);
export const isUuidText = value => typeof value === "string" && value.length === 36 && value.split("-").map(part=>part.length).join(",") === "8,4,4,4,12" && value.split("-").every(isHex);
export function titleWords(value) {
  let result = "", boundary = true;
  for (const char of String(value || "")) {
    const word = isAsciiLetter(char) || isAsciiDigit(char) || char === "_";
    result += boundary && word ? char.toUpperCase() : char;
    boundary = !word;
  }
  return result;
}
