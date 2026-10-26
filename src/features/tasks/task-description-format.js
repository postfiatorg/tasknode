// Task text arrives from task generation as one dense paragraph. This module
// turns it into readable blocks without changing a word: a lead sentence, short
// paragraphs, payment terms pulled into their own block, and linked URLs and
// GitHub issue references. Text that already contains Markdown structure keeps
// its own structure.

const ABBREVIATIONS = /(?:\b(?:e\.g|i\.e|etc|vs|approx|incl|no|fig|cf|ca|Mr|Ms|Dr|St|U\.S)\.)$/i;
const PAYMENT_PATTERN = /\b(?:pays?|paid|payment|payout|will not be paid|not be paid|reward(?:ed)? only|only pays|eligible|not eligible)\b/i;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g;
const BARE_DOMAIN_PATTERN = /\b(?:github\.com|postfiat\.org|tasknode\.postfiat\.org)\/[^\s<>()]*[^\s<>().,;:!?'"]/g;
const REPO_PATTERN = /\b(postfiatorg|agticorp|goodalexander)\/([A-Za-z0-9._-]+[A-Za-z0-9_-])/;
const ISSUE_PATTERN = /(?:\b(?:issue|PR|pull request)\s+)?#(\d{1,6})\b/g;

function hasMarkdownStructure(text) {
  return /\n\s*\n/.test(text) || /(^|\n)\s*(?:[-*]\s|\d+[.)]\s|#{1,3}\s)/.test(text);
}

export function splitSentences(text = "") {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return [];
  const sentences = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char !== "." && char !== "!" && char !== "?") continue;
    const next = source[index + 1];
    const after = source[index + 2];
    // End of a sentence: terminal punctuation, then a space and an uppercase
    // letter, digit, quote or opening bracket. Decimals, domains and file
    // extensions never have a space after the dot.
    const closingQuote = next === "\"" || next === "'" || next === ")";
    const boundaryIndex = closingQuote ? index + 2 : index + 1;
    if (boundaryIndex < source.length && source[boundaryIndex] !== " ") continue;
    const lookahead = closingQuote ? source[index + 3] : after;
    if (boundaryIndex < source.length && lookahead && !/[A-Z0-9"'(\[`]/.test(lookahead)) continue;
    const candidate = source.slice(start, boundaryIndex).trim();
    if (char === "." && ABBREVIATIONS.test(candidate)) continue;
    if (candidate) sentences.push(candidate);
    start = boundaryIndex + 1;
  }
  const tail = source.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

function repoFromText(text = "") {
  const match = String(text || "").match(REPO_PATTERN);
  return match ? `${match[1]}/${match[2].replace(/\.git$/, "")}` : "";
}

function trimTrailingPunctuation(value) {
  return value.replace(/[.,;:!?]+$/, "");
}

// Inline parts use the same shape as chat Markdown: { text } | { link, href }
// | { code } | { bold }.
export function linkifyInline(text = "", { repo = "" } = {}) {
  const source = String(text || "");
  const matches = [];
  for (const match of source.matchAll(URL_PATTERN)) {
    matches.push({ index: match.index, length: match[0].length, link: match[0], href: trimTrailingPunctuation(match[0]) });
  }
  for (const match of source.matchAll(BARE_DOMAIN_PATTERN)) {
    const overlaps = matches.some((item) => match.index >= item.index && match.index < item.index + item.length);
    const precededByScheme = /:\/\/$/.test(source.slice(Math.max(0, match.index - 3), match.index));
    if (!overlaps && !precededByScheme) {
      matches.push({ index: match.index, length: match[0].length, link: match[0], href: `https://${trimTrailingPunctuation(match[0])}` });
    }
  }
  for (const match of source.matchAll(new RegExp(REPO_PATTERN.source, "g"))) {
    const overlaps = matches.some((item) => match.index < item.index + item.length && match.index + match[0].length > item.index);
    if (!overlaps) {
      matches.push({ index: match.index, length: match[0].length, link: match[0], href: `https://github.com/${match[1]}/${match[2].replace(/\.git$/, "")}` });
    }
  }
  if (repo) {
    for (const match of source.matchAll(ISSUE_PATTERN)) {
      const overlaps = matches.some((item) => match.index < item.index + item.length && match.index + match[0].length > item.index);
      if (overlaps) continue;
      const kind = /^(?:PR|pull request)\b/i.test(match[0]) ? "pull" : "issues";
      matches.push({ index: match.index, length: match[0].length, link: match[0], href: `https://github.com/${repo}/${kind}/${match[1]}` });
    }
  }
  matches.sort((a, b) => a.index - b.index);
  const parts = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index < cursor) continue;
    if (match.index > cursor) parts.push({ text: source.slice(cursor, match.index) });
    parts.push({ link: match.link, href: match.href });
    cursor = match.index + match.length;
  }
  if (cursor < source.length) parts.push({ text: source.slice(cursor) });
  return parts.length ? parts : [{ text: source }];
}

function paragraphsFromSentences(sentences, maxChars = 260) {
  const paragraphs = [];
  let current = [];
  let length = 0;
  for (const sentence of sentences) {
    if (current.length && (length + sentence.length > maxChars || current.length >= 3)) {
      paragraphs.push(current.join(" "));
      current = [];
      length = 0;
    }
    current.push(sentence);
    length += sentence.length;
  }
  if (current.length) paragraphs.push(current.join(" "));
  return paragraphs;
}

// Returns { lead, paragraphs, terms, markdown } where every text field is an
// array of inline parts. `markdown` is the raw text when the author already
// used Markdown structure; render it with the Markdown renderer instead.
export function formatTaskDescription(description = "", { repo = "" } = {}) {
  const text = String(description || "").trim();
  const resolvedRepo = repo || repoFromText(text);
  if (!text) return { lead: null, paragraphs: [], terms: [], markdown: "" };
  if (hasMarkdownStructure(text)) return { lead: null, paragraphs: [], terms: [], markdown: text, repo: resolvedRepo };

  const sentences = splitSentences(text);
  if (sentences.length <= 2) {
    return { lead: null, paragraphs: [linkifyInline(sentences.join(" "), { repo: resolvedRepo })], terms: [], markdown: "", repo: resolvedRepo };
  }
  const [first, ...rest] = sentences;
  const body = [];
  const terms = [];
  for (const sentence of rest) {
    if (PAYMENT_PATTERN.test(sentence)) terms.push(sentence);
    else body.push(sentence);
  }
  return {
    lead: linkifyInline(first, { repo: resolvedRepo }),
    paragraphs: paragraphsFromSentences(body).map((paragraph) => linkifyInline(paragraph, { repo: resolvedRepo })),
    terms: terms.map((sentence) => linkifyInline(sentence, { repo: resolvedRepo })),
    markdown: "",
    repo: resolvedRepo,
  };
}

// Verification text: same sentence grouping, no lead or terms split, so the
// requirement reads in its original order.
export function formatTaskParagraphs(text = "", { repo = "" } = {}) {
  const source = String(text || "").trim();
  if (!source) return [];
  const resolvedRepo = repo || repoFromText(source);
  return paragraphsFromSentences(splitSentences(source)).map((paragraph) => linkifyInline(paragraph, { repo: resolvedRepo }));
}

export function taskRepoFromTexts(...texts) {
  for (const text of texts) {
    const repo = repoFromText(text);
    if (repo) return repo;
  }
  return "";
}

export function verificationTitleLabel(title = "") {
  return String(title || "")
    .replace(/\bUrl\b/g, "URL")
    .replace(/\bPr\b/g, "PR")
    .replace(/\bId\b/g, "ID")
    .replace(/\bApi\b/g, "API")
    .replace(/\bPdf\b/g, "PDF");
}
