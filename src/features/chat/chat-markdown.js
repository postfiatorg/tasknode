export function markdownToBlocks(input) {
  const text = String(input || "").trim();
  if (!text) return [{ type: "p", inline: [{ text: "" }] }];

  let normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/([^\n])\s+(\d+\.\s+\*\*)/g, "$1\n$2")
    .replace(/([^\n])\s+(\d+\.\s+[A-Z])/g, "$1\n$2");
  if (looksLikeMarkdownTable(normalized)) {
    normalized = normalizeCompactMarkdownTables(normalized);
  }
  const lines = normalized.split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    blocks.push({ type: "p", inline: parseInline(paragraph.join(" ").trim()) });
    paragraph = [];
  }

  function flushList() {
    if (!list) return;
    blocks.push(list);
    list = null;
  }

  function pushList(type, rawItem) {
    flushParagraph();
    if (!list || list.type !== type) {
      flushList();
      list = { type, items: [] };
    }
    list.items.push(parseInline(rawItem.trim()));
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const raw = line.trim();
    if (!raw) {
      flushParagraph();
      flushList();
      continue;
    }

    const nextRaw = (lines[lineIndex + 1] || "").trim();
    if (isMarkdownTableRow(raw) && isMarkdownTableSeparatorRow(nextRaw)) {
      const headers = splitMarkdownTableRow(raw);
      const alignments = splitMarkdownTableRow(nextRaw).map(tableColumnAlignment);
      const rows = [];

      lineIndex += 2;
      while (lineIndex < lines.length) {
        const rowRaw = lines[lineIndex].trim();
        if (!isMarkdownTableRow(rowRaw) || isMarkdownTableSeparatorRow(rowRaw)) break;
        rows.push(normalizeTableCells(splitMarkdownTableRow(rowRaw), headers.length));
        lineIndex += 1;
      }
      lineIndex -= 1;

      flushParagraph();
      flushList();
      blocks.push({
        type: "table",
        headers: headers.map((cell) => parseInline(cell)),
        alignments: normalizeTableCells(alignments, headers.length, "left"),
        rows: rows.map((row) => row.map((cell) => parseInline(cell))),
      });
      continue;
    }

    const h2 = raw.match(/^##\s+(.+)/);
    const h3 = raw.match(/^###\s+(.+)/);
    const quote = raw.match(/^>\s+(.+)/);
    const ul = raw.match(/^[-*]\s+(.+)/);
    const ol = raw.match(/^\d+[.)]\s+(.+)/);

    if (/^---+$/.test(raw)) {
      flushParagraph();
      flushList();
      blocks.push({ type: "hr" });
    } else if (h3) {
      flushParagraph();
      flushList();
      blocks.push({ type: "h3", inline: parseInline(h3[1]) });
    } else if (h2) {
      flushParagraph();
      flushList();
      blocks.push({ type: "h2", inline: parseInline(h2[1]) });
    } else if (quote) {
      flushParagraph();
      flushList();
      blocks.push({ type: "quote", inline: parseInline(quote[1]) });
    } else if (ul) {
      pushList("ul", ul[1]);
    } else if (ol) {
      pushList("ol", ol[1]);
    } else {
      paragraph.push(raw);
    }
  }

  flushParagraph();
  flushList();
  return blocks.length > 0 ? blocks : [{ type: "p", inline: [{ text }] }];
}

export function plainTextFromBlocks(blocks) {
  return (blocks || [])
    .map((block) => {
      if (block.type === "ul" || block.type === "ol") {
        return (block.items || [])
          .map((item) => inlineToText(Array.isArray(item) ? item : [{ text: item }]))
          .join("\n");
      }
      if (block.type === "table") {
        const header = (block.headers || []).map(inlineToText).join(" | ");
        const rows = (block.rows || []).map((row) => row.map(inlineToText).join(" | "));
        return [header, ...rows].filter(Boolean).join("\n");
      }
      return inlineToText(block.inline || [{ text: block.text || "" }]);
    })
    .filter(Boolean)
    .join("\n\n");
}

function looksLikeMarkdownTable(input) {
  return /\|\s*:?-{3,}:?\s*\|/.test(String(input || ""));
}

function normalizeCompactMarkdownTables(input) {
  return String(input || "")
    .split("\n")
    .map((line) => {
      const parts = line.split(/\|\s+\|/);
      if (parts.length < 3) return line;

      const rows = parts.map((part, index) => {
        if (index === 0) return `${part}|`;
        if (index === parts.length - 1) return `|${part}`;
        return `|${part}|`;
      });
      return isMarkdownTableRow(rows[0]) && isMarkdownTableSeparatorRow(rows[1])
        ? rows.join("\n")
        : line;
    })
    .join("\n");
}

function isMarkdownTableRow(line) {
  const raw = String(line || "").trim();
  return raw.startsWith("|") && raw.endsWith("|") && splitMarkdownTableRow(raw).length >= 2;
}

function isMarkdownTableSeparatorRow(line) {
  if (!isMarkdownTableRow(line)) return false;
  return splitMarkdownTableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function splitMarkdownTableRow(line) {
  const raw = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "");
  return raw.split("|").map((cell) => cell.trim());
}

function tableColumnAlignment(cell) {
  const value = String(cell || "").trim();
  if (value.startsWith(":") && value.endsWith(":")) return "center";
  if (value.endsWith(":")) return "right";
  return "left";
}

function normalizeTableCells(cells, count, fallback = "") {
  return Array.from({ length: Math.max(0, count) }, (_, index) => cells[index] || fallback);
}

function parseInline(input) {
  const text = String(input || "");
  const parts = [];
  const pattern = /(\[[^\]]+\]\(https?:\/\/[^)\s]+\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index) });
    }

    const token = match[0];
    if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      if (linkMatch) {
        parts.push({ link: linkMatch[1], href: linkMatch[2] });
      } else {
        parts.push({ text: token });
      }
    } else if (token.startsWith("`")) {
      parts.push({ code: token.slice(1, -1) });
    } else if (token.startsWith("**")) {
      parts.push({ bold: token.slice(2, -2) });
    } else if (token.startsWith("*")) {
      parts.push({ italic: token.slice(1, -1) });
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex) });
  }

  return parts.length > 0 ? parts : [{ text }];
}

function inlineToText(parts) {
  return (parts || [])
    .map((part) => part.text || part.bold || part.italic || part.code || "")
    .join("");
}
