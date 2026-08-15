#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const workspaceRoot = path.dirname(repoRoot);
const whitepaperRepo = path.resolve(
  process.env.POSTFIAT_L1V2_REPO || path.join(workspaceRoot, "postfiatl1v2-origin-main")
);
const blogRepo = path.resolve(
  process.env.POSTFIAT_BLOG_REPO || path.join(workspaceRoot, "postfiatorg", "postfiatorg.github.io")
);
const whitepaperRef = process.env.POSTFIAT_L1V2_REF || "origin/main";
const blogRef = process.env.POSTFIAT_BLOG_REF || "origin/main";
const outputPath = path.join(repoRoot, "prompts", "chat_modules", "post_fiat_knowledge.json");

function git(repo, args) {
  if (!existsSync(path.join(repo, ".git"))) throw new Error(`post_fiat_source_repo_missing:${repo}`);
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
}

function cleanScalar(value = "") {
  const text = String(value || "").trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  return text;
}

function parseMarkdownDocument(source = "") {
  const normalized = String(source || "").replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return { frontMatter: {}, body: normalized.trim() };
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) return { frontMatter: {}, body: normalized.trim() };
  const frontMatter = {};
  let activeList = "";
  for (const line of normalized.slice(4, closing).split("\n")) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (field) {
      activeList = field[1];
      frontMatter[activeList] = field[2] ? cleanScalar(field[2]) : [];
      continue;
    }
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && activeList) {
      if (!Array.isArray(frontMatter[activeList])) frontMatter[activeList] = [];
      frontMatter[activeList].push(cleanScalar(item[1]));
    }
  }
  return { frontMatter, body: normalized.slice(closing + 5).trim() };
}

function compactMarkdown(value = "") {
  return String(value || "")
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/<script[^]*?<\/script>/gi, " ")
    .replace(/<style[^]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s*\{\{[^\n]+\}\}\s*$/gm, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitLongSection(text = "", maxChars = 4600) {
  const paragraphs = compactMarkdown(text).split(/\n\s*\n/).filter(Boolean);
  const parts = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > maxChars) {
      parts.push(current.trim());
      current = "";
    }
    if (paragraph.length <= maxChars) {
      current = [current, paragraph].filter(Boolean).join("\n\n");
      continue;
    }
    if (current) parts.push(current.trim());
    current = "";
    for (let offset = 0; offset < paragraph.length; offset += maxChars) {
      parts.push(paragraph.slice(offset, offset + maxChars).trim());
    }
  }
  if (current) parts.push(current.trim());
  return parts.filter(Boolean);
}

function markdownChunks({ sourceId, sourceType, title, sourcePath, url, date = "", draft = false, tags = [], body }) {
  const sections = [];
  let heading = "Overview";
  let lines = [];
  const flush = () => {
    const raw = lines.join("\n").trim();
    if (raw) sections.push({ heading, raw });
    lines = [];
  };
  for (const line of String(body || "").split("\n")) {
    const match = line.match(/^(#{1,3})\s+(.+)$/);
    if (match) {
      flush();
      heading = match[2].trim();
    } else {
      lines.push(line);
    }
  }
  flush();

  const chunks = [];
  for (const section of sections) {
    const parts = splitLongSection(section.raw);
    parts.forEach((text, index) => {
      chunks.push({
        id: `${sourceId}:${chunks.length + 1}`,
        sourceId,
        sourceType,
        title,
        heading: parts.length > 1 ? `${section.heading} (${index + 1}/${parts.length})` : section.heading,
        sourcePath,
        url,
        date,
        draft,
        tags,
        text,
      });
    });
  }
  return chunks;
}

function sourceHash(value = "") {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

const whitepaperCommit = git(whitepaperRepo, ["rev-parse", whitepaperRef]);
const blogCommit = git(blogRepo, ["rev-parse", blogRef]);
const whitepaperPath = "docs/whitepaper.md";
const whitepaperSource = git(whitepaperRepo, ["show", `${whitepaperRef}:${whitepaperPath}`]);
const whitepaperDocument = parseMarkdownDocument(whitepaperSource);
const whitepaperTitle = whitepaperDocument.body.match(/^#\s+(.+)$/m)?.[1]?.trim() || "PostFiat Whitepaper";
const whitepaperUrl = `https://github.com/postfiatorg/postfiatl1v2/blob/${whitepaperCommit}/${whitepaperPath}`;
const whitepaperPreamble = whitepaperDocument.body.split(/\n## Abstract\s*\n/)[0] || "";
const whitepaperAbstract =
  whitepaperDocument.body.match(/## Abstract\s+([^]*?)(?=\n##\s)/)?.[1] || whitepaperDocument.body.slice(0, 1800);
const whitepaperSummary = compactMarkdown(`${whitepaperPreamble}\n\n${whitepaperAbstract}`).slice(0, 2600);

const blogPaths = git(blogRepo, ["ls-tree", "-r", "--name-only", blogRef, "--", "content/blog"])
  .split("\n")
  .map((entry) => entry.trim())
  .filter((entry) => entry.endsWith(".md") && !entry.endsWith("/_index.md"))
  .sort();
if (blogPaths.length === 0) throw new Error("post_fiat_blog_archive_empty");

const blogSources = [];
const chunks = markdownChunks({
  sourceId: "whitepaper",
  sourceType: "whitepaper",
  title: whitepaperTitle,
  sourcePath: whitepaperPath,
  url: whitepaperUrl,
  body: whitepaperDocument.body,
});

for (const sourcePath of blogPaths) {
  const source = git(blogRepo, ["show", `${blogRef}:${sourcePath}`]);
  const { frontMatter, body } = parseMarkdownDocument(source);
  const slug = path.basename(sourcePath, ".md");
  const title = String(frontMatter.title || body.match(/^#\s+(.+)$/m)?.[1] || slug).trim();
  const date = String(frontMatter.date || "").trim();
  const draft = String(frontMatter.draft || "false").toLowerCase() === "true";
  const tags = Array.isArray(frontMatter.tags) ? frontMatter.tags : [];
  const summary = compactMarkdown(frontMatter.summary || frontMatter.description || body).slice(0, 1100);
  const publicPath = String(frontMatter.url || `/blog/${slug}/`).trim();
  const publicUrl = `https://postfiat.org${publicPath.startsWith("/") ? publicPath : `/${publicPath}`}`;
  const repositoryUrl = `https://github.com/postfiatorg/postfiatorg.github.io/blob/${blogCommit}/${sourcePath}`;
  const url = draft ? repositoryUrl : publicUrl;
  const sourceId = `blog:${slug}`;
  const sourceRecord = {
    id: sourceId,
    title,
    date,
    draft,
    summary,
    tags,
    sourcePath,
    url,
    publicUrl: draft ? "" : publicUrl,
    repositoryUrl,
    sha256: sourceHash(source),
  };
  blogSources.push(sourceRecord);
  chunks.push(...markdownChunks({ sourceId, sourceType: "blog", title, sourcePath, url, date, draft, tags, body }));
}

const payload = {
  schemaVersion: 1,
  sources: {
    whitepaper: {
      id: "whitepaper",
      title: whitepaperTitle,
      summary: whitepaperSummary,
      sourcePath: whitepaperPath,
      url: whitepaperUrl,
      repository: "https://github.com/postfiatorg/postfiatl1v2",
      commit: whitepaperCommit,
      sha256: sourceHash(whitepaperSource),
    },
    blogArchive: {
      repository: "https://github.com/postfiatorg/postfiatorg.github.io",
      commit: blogCommit,
      articleCount: blogSources.length,
      articles: blogSources,
    },
  },
  chunks,
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(payload)}\n`, "utf8");
console.log(
  `post fiat knowledge synced: whitepaper=${whitepaperCommit.slice(0, 8)} blogs=${blogCommit.slice(0, 8)} articles=${blogSources.length} chunks=${chunks.length}`
);
