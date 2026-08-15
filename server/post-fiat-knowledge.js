import { loadPrompt } from "./prompt-registry.js";

const corpus = JSON.parse(loadPrompt("chat_modules/post_fiat_knowledge.json"));
const stopWords = new Set([
  "about", "after", "also", "and", "are", "can", "does", "for", "from", "have", "how", "into", "its",
  "more", "post", "fiat", "should", "that", "the", "their", "then", "this", "was", "what", "when", "where",
  "which", "whitepaper", "who", "why", "with", "would", "you", "your",
]);
const synonymGroups = [
  ["xrp", "xrpl", "ripple"],
  ["privacy", "private", "shielded", "orchard", "halo2"],
  ["governance", "cobalt", "registry", "validator", "unl"],
  ["stablecoin", "usdc", "pfusdc", "bridge"],
  ["nav", "navcoin", "a651", "collateral", "reserve", "tvl"],
  ["replay", "replayable", "inference", "classification", "oracle"],
  ["terminal", "pfterminal", "coding", "harness"],
  ["fx", "foreign", "exchange", "pnok", "nok"],
  ["quantum", "postquantum", "mldsa", "signature"],
  ["latency", "fastpay", "finality", "performance"],
];

function normalizeText(value = "") {
  return String(value || "").toLowerCase().replaceAll("-", "").replace(/[^a-z0-9]+/g, " ").trim();
}

function queryTokens(message = "") {
  const base = new Set(
    normalizeText(message)
      .split(/\s+/)
      .filter((token) => token.length > 1 && !stopWords.has(token))
  );
  for (const group of synonymGroups) {
    if (group.some((term) => base.has(normalizeText(term)))) {
      group.forEach((term) => base.add(normalizeText(term)));
    }
  }
  return [...base];
}

function occurrences(haystack = "", needle = "") {
  if (!needle) return 0;
  return Math.max(0, String(haystack).split(needle).length - 1);
}

function chunkScore(chunk, tokens, phrase) {
  const title = normalizeText(chunk.title);
  const heading = normalizeText(chunk.heading);
  const tags = normalizeText((chunk.tags || []).join(" "));
  const text = normalizeText(chunk.text);
  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 14;
    if (heading.includes(token)) score += 10;
    if (tags.includes(token)) score += 7;
    score += Math.min(occurrences(text, token), 5) * 1.5;
  }
  if (phrase.length > 5 && `${title} ${heading} ${text}`.includes(phrase)) score += 24;
  if (chunk.sourceType === "whitepaper") score += 1.5;
  if (chunk.draft) score *= 0.72;
  return score;
}

function sourceStatus(article) {
  return article.draft ? "unpublished draft/proposal" : `published${article.date ? ` ${article.date.slice(0, 10)}` : ""}`;
}

function formatCatalog() {
  return corpus.sources.blogArchive.articles
    .map((article) => `- [${sourceStatus(article)}] ${article.title} — ${article.summary} Source: ${article.url}`)
    .join("\n");
}

function selectedChunks(message = "", limit = 8) {
  const tokens = queryTokens(message);
  const phrase = normalizeText(message);
  const ranked = corpus.chunks
    .map((chunk) => ({ chunk, score: chunkScore(chunk, tokens, phrase) }))
    .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id));
  const selected = [];
  const seen = new Set();
  const sourceCounts = new Map();
  const add = (chunk, { force = false } = {}) => {
    if (!chunk || seen.has(chunk.id)) return;
    const sourceCount = sourceCounts.get(chunk.sourceId) || 0;
    if (!force && sourceCount >= 3) return;
    seen.add(chunk.id);
    sourceCounts.set(chunk.sourceId, sourceCount + 1);
    selected.push(chunk);
  };
  add(corpus.chunks.find((chunk) => chunk.sourceType === "whitepaper" && /^Abstract/i.test(chunk.heading)), { force: true });
  const bestWhitepaper = ranked.find(
    (entry) => entry.chunk.sourceType === "whitepaper" && entry.score > 4 && !seen.has(entry.chunk.id)
  );
  if (bestWhitepaper) add(bestWhitepaper.chunk, { force: true });
  if (tokens.length === 0) {
    add(corpus.chunks.find((chunk) => chunk.sourceType === "whitepaper" && /^1\. Introduction/i.test(chunk.heading)));
    add(corpus.chunks.find((chunk) => chunk.sourceId === "blog:community-update-august-2026"));
  }
  for (const entry of ranked) {
    if (selected.length >= limit) break;
    if (entry.score <= 0 && selected.length >= 3) break;
    add(entry.chunk);
  }
  return selected.slice(0, limit);
}

export function postFiatKnowledgeMetadata() {
  return {
    schemaVersion: corpus.schemaVersion,
    whitepaper: corpus.sources.whitepaper,
    blogCommit: corpus.sources.blogArchive.commit,
    blogArticleCount: corpus.sources.blogArchive.articleCount,
    chunkCount: corpus.chunks.length,
  };
}

export function formatPostFiatKnowledgeContext({ message = "" } = {}) {
  const whitepaper = corpus.sources.whitepaper;
  const snippets = selectedChunks(message)
    .map((chunk, index) => [
      `### Snippet ${index + 1}: ${chunk.title} — ${chunk.heading}`,
      `Status: ${chunk.sourceType === "whitepaper" ? "canonical protocol document" : sourceStatus(chunk)}`,
      `Source: ${chunk.url}`,
      chunk.text,
    ].join("\n"))
    .join("\n\n");
  return [
    `<post_fiat_knowledge whitepaper_commit="${whitepaper.commit}" blog_commit="${corpus.sources.blogArchive.commit}">`,
    "## Source precedence",
    "The canonical whitepaper controls protocol architecture and implementation-boundary claims. Published dated blog posts provide product, experiment, benchmark, and implementation evidence as of their dates. Draft/proposal posts are idea records only and must be labeled as such. Conflicts resolve in that order.",
    "",
    `## Canonical whitepaper: ${whitepaper.title}`,
    `Source: ${whitepaper.url}`,
    whitepaper.summary,
    "",
    `## Complete blog archive catalog (${corpus.sources.blogArchive.articleCount} articles)`,
    formatCatalog(),
    "",
    "## Question-relevant source snippets",
    snippets,
    "</post_fiat_knowledge>",
  ].join("\n");
}
