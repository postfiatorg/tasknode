// A small deterministic renderer for research Markdown. No HTML execution or
// regular expressions; unknown syntax remains readable text.
export function researchInline(input) {
  const text = String(input || "");
  const parts = [];
  let plain = "";
  const flush = () => { if (plain) parts.push({ text: plain }); plain = ""; };
  for (let i = 0; i < text.length;) {
    if (text[i] === "\\" && i + 1 < text.length) { plain += text[i + 1]; i += 2; continue; }
    if (text[i] === "[") {
      const labelEnd = text.indexOf("](", i + 1);
      const end = labelEnd < 0 ? -1 : text.indexOf(")", labelEnd + 2);
      if (end > labelEnd) {
        let href = text.slice(labelEnd + 2, end).trim();
        if (href.startsWith("<") && href.endsWith(">")) href = href.slice(1, -1);
        try {
          const url = new URL(href);
          if (["http:", "https:"].includes(url.protocol)) {
            flush(); parts.push({ link: text.slice(i + 1, labelEnd), href: url.href }); i = end + 1; continue;
          }
        } catch { /* Keep an invalid link as text. */ }
      }
    }
    const marker = text.startsWith("**", i) ? "**" : text[i] === "`" ? "`" : text[i] === "*" ? "*" : "";
    const end = marker ? text.indexOf(marker, i + marker.length) : -1;
    if (marker && end > i + marker.length) {
      flush(); parts.push({ [marker === "`" ? "code" : marker === "**" ? "bold" : "italic"]: text.slice(i + marker.length, end) });
      i = end + marker.length; continue;
    }
    plain += text[i++];
  }
  flush();
  return parts;
}

function cells(line) {
  let raw = line.trim();
  if (raw.startsWith("|")) raw = raw.slice(1);
  if (raw.endsWith("|") && !raw.endsWith("\\|")) raw = raw.slice(0, -1);
  const result = [];
  let cell = "", code = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === "\\" && i + 1 < raw.length) { cell += char + raw[++i]; continue; }
    if (char === "`") code = !code;
    if (char === "|" && !code) { result.push(cell.trim()); cell = ""; } else cell += char;
  }
  result.push(cell.trim());
  return result;
}

function separator(cell) {
  let raw = cell.trim();
  if (raw.startsWith(":")) raw = raw.slice(1);
  if (raw.endsWith(":")) raw = raw.slice(0, -1);
  return raw.length >= 3 && Array.from(raw).every(char => char === "-");
}

function listItem(line) {
  if (line.startsWith("- ") || line.startsWith("* ") || line.startsWith("+ ")) return { type: "ul", text: line.slice(2) };
  let i = 0;
  while (line[i] >= "0" && line[i] <= "9") i++;
  if (i && [".", ")"].includes(line[i]) && line[i + 1] === " ") return { type: "ol", start: Number(line.slice(0, i)), text: line.slice(i + 2) };
  return null;
}

export function researchMarkdownToBlocks(input) {
  const lines = String(input || "").replaceAll("\r\n", "\n").split("\n");
  const blocks = [];
  let paragraph = [], list = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "p", inline: researchInline(paragraph.join(" ")) });
    if (list) blocks.push(list);
    paragraph = []; list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) { flush(); continue; }
    if (raw.startsWith("```") || raw.startsWith("~~~")) {
      flush(); const marker = raw.slice(0, 3); const code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(marker); i++) code.push(lines[i]);
      blocks.push({ type: "code", text: code.join("\n") }); continue;
    }
    const headings = cells(raw), dividers = cells(lines[i + 1] || "");
    if (headings.length >= 2 && dividers.length === headings.length && dividers.every(separator)) {
      flush(); const rows = []; i += 2;
      for (; i < lines.length; i++) {
        const row = cells(lines[i]);
        if (!lines[i].trim() || row.length < 2) break;
        rows.push(headings.map((_, index) => researchInline(row[index] || "")));
      }
      i--;
      blocks.push({ type: "table", headers: headings.map(researchInline),
        alignments: dividers.map(value => value.endsWith(":") ? value.startsWith(":") ? "center" : "right" : "left"), rows });
      continue;
    }
    let level = 0;
    while (raw[level] === "#") level++;
    if (level > 0 && level <= 6 && raw[level] === " ") {
      flush(); blocks.push({ type: level <= 2 ? "h2" : "h3", inline: researchInline(raw.slice(level + 1)) }); continue;
    }
    if (raw.startsWith("> ")) { flush(); blocks.push({ type: "quote", inline: researchInline(raw.slice(2)) }); continue; }
    if (raw.length >= 3 && Array.from(raw).every(char => char === "-")) { flush(); blocks.push({ type: "hr" }); continue; }
    const item = listItem(raw);
    if (item) {
      if (paragraph.length || (list && list.type !== item.type)) flush();
      list ||= { type: item.type, start: item.start || 1, items: [] };
      list.items.push(researchInline(item.text)); continue;
    }
    if (list) flush();
    paragraph.push(raw);
  }
  flush();
  return blocks;
}
