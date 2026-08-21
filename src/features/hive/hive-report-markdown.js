function parseTableCells(line = "") {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isTableDelimiter(cells) {
  return Array.isArray(cells) && cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function expandCollapsedTableLine(line = "") {
  const original = String(line || "");
  const trimmedEnd = original.replace(/\s+$/, "");
  const trimmed = trimmedEnd.trim();
  const tableStart = trimmed.indexOf("|");
  if (tableStart < 0) return [original];

  const prefix = trimmed.slice(0, tableStart).trim();
  const tableText = trimmed.slice(tableStart);
  const rows = tableText.split(/(?<=\|)\s+(?=\|)/).map((row) => row.trim()).filter(Boolean);
  if (rows.length < 2 || !rows.some((row) => isTableDelimiter(parseTableCells(row)))) return [original];

  const indent = /^\s*/.exec(original)?.[0] || "";
  return [
    prefix ? `${indent}${prefix}` : "",
    ...rows.map((row) => `${indent}${row}`),
  ].filter(Boolean);
}

export function normalizeHiveReportMarkdown(markdown = "") {
  return String(markdown || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap(expandCollapsedTableLine)
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n");
}

function nextNonEmptyLine(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    const trimmed = String(lines[index] || "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function isPlainSectionHeading(line = "", nextLine = "") {
  if (!parseTableCells(nextLine)) return false;
  if (line.length > 80 || /[.!?:;]$/.test(line)) return false;
  return /^[A-Z0-9][A-Za-z0-9 /&(),._-]+$/.test(line);
}

export function parseMarkdownBlocks(markdown = "") {
  const lines = normalizeHiveReportMarkdown(markdown).split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;
  let code = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const flushList = () => {
    if (!list?.items?.length) return;
    blocks.push(list);
    list = null;
  };
  const flushCode = () => {
    if (!code) return;
    blocks.push({ type: "code", text: code.lines.join("\n") });
    code = null;
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flushParagraph();
      flushList();
      if (code) flushCode();
      else code = { lines: [] };
      continue;
    }
    if (code) {
      code.lines.push(line);
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }
    if (/^-{3,}$/.test(trimmed)) {
      flushParagraph();
      flushList();
      blocks.push({ type: "rule" });
      continue;
    }

    const tableHeader = parseTableCells(trimmed);
    const tableDelimiter = parseTableCells(String(lines[lineIndex + 1] || "").trim());
    if (tableHeader && isTableDelimiter(tableDelimiter)) {
      flushParagraph();
      flushList();
      const rows = [];
      lineIndex += 2;
      for (; lineIndex < lines.length; lineIndex += 1) {
        const rowCells = parseTableCells(String(lines[lineIndex] || "").trim());
        if (!rowCells || isTableDelimiter(rowCells)) break;
        rows.push(rowCells);
      }
      lineIndex -= 1;
      blocks.push({ type: "table", header: tableHeader, rows });
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: Math.min(heading[1].length, 4), text: heading[2] });
      continue;
    }
    if (isPlainSectionHeading(trimmed, nextNonEmptyLine(lines, lineIndex + 1))) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: 2, text: trimmed });
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    const ordered = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (bullet || ordered) {
      flushParagraph();
      const type = ordered ? "ordered" : "unordered";
      if (!list || list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push((bullet || ordered)[1]);
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  flushCode();
  return blocks;
}
