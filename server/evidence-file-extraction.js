import { gunzipSync, unzipSync } from "fflate";
import { fileURLToPath } from "node:url";

export const MAX_EVIDENCE_FILE_BYTES = 2_500_000;
export const MAX_EXTRACTED_TEXT_CHARS = 120_000;

const MAX_ARCHIVE_ENTRIES = 100;
const MAX_ARCHIVE_ENTRY_BYTES = 1_500_000;
const MAX_ARCHIVE_OUTPUT_BYTES = 6_000_000;
const MAX_PDF_PAGES = 250;
const MAX_VISUAL_PAGES = 4;
const MAX_EMBEDDED_IMAGES = 6;

const textExtensions = new Set([
  "adoc", "bash", "c", "cc", "cfg", "cjs", "conf", "cpp", "cs", "css", "csv", "dockerfile",
  "env", "go", "h", "hpp", "htm", "html", "ini", "java", "js", "json", "jsx", "kt", "log", "md",
  "markdown", "mjs", "php", "properties", "ps1", "py", "rb", "rs", "rst", "sh", "sql", "swift", "toml",
  "ts", "tsx", "txt", "xml", "yaml", "yml", "zsh",
]);

function cleanText(value = "", max = MAX_EXTRACTED_TEXT_CHARS) {
  const normalized = String(value || "")
    .replaceAll("\u0000", "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}\n[system_note: extracted_text_truncated]`;
}

function extensionFor(name = "") {
  const normalized = String(name || "").trim().toLowerCase().split(/[?#]/, 1)[0];
  const base = normalized.split("/").at(-1) || "";
  if (base === "dockerfile") return "dockerfile";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1) : "";
}

function withoutExtension(name = "") {
  return String(name || "").replace(/\.[^.]+$/, "");
}

function isTextFile(name = "", mimeType = "") {
  const normalizedMime = String(mimeType || "").toLowerCase().split(";", 1)[0];
  return normalizedMime.startsWith("text/") ||
    ["application/json", "application/csv", "application/javascript", "application/xml", "application/yaml"].includes(normalizedMime) ||
    textExtensions.has(extensionFor(name));
}

function decodeXmlEntities(value = "") {
  return String(value || "")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&amp;/gi, "&");
}

function textFromWordXml(xml = "") {
  const withLayout = String(xml || "")
    .replace(/<w:tab\b[^>]*\/?\s*>/gi, "\t")
    .replace(/<w:(?:br|cr)\b[^>]*\/?\s*>/gi, "\n")
    .replace(/<\/w:(?:p|tr)>/gi, "\n");
  const parts = [...withLayout.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)]
    .map((match) => decodeXmlEntities(match[1]));
  if (parts.length) return cleanText(parts.join(" ").replace(/\s+\n/g, "\n").replace(/\n\s+/g, "\n"));
  return "";
}

function zipEntries(buffer, filter) {
  let selectedEntries = 0;
  let selectedBytes = 0;
  const skipped = [];
  const output = unzipSync(new Uint8Array(buffer), {
    filter(file) {
      if (!file?.name || file.name.endsWith("/")) return false;
      selectedEntries += 1;
      const originalSize = Number(file.originalSize || 0);
      if (selectedEntries > MAX_ARCHIVE_ENTRIES) {
        throw Object.assign(new Error("evidence_archive_too_many_entries"), { status: 422 });
      }
      if (!filter(file.name)) return false;
      if (originalSize > MAX_ARCHIVE_ENTRY_BYTES || selectedBytes + originalSize > MAX_ARCHIVE_OUTPUT_BYTES) {
        skipped.push(file.name);
        return false;
      }
      selectedBytes += originalSize;
      return true;
    },
  });
  return { output, skipped };
}

function extractDocx(buffer) {
  const { output } = zipEntries(buffer, (name) => (
    /^word\/(?:document|footnotes|endnotes|comments|header\d+|footer\d+)\.xml$/i.test(name) ||
    /^word\/media\/[^/]+\.(?:png|jpe?g|webp|gif)$/i.test(name)
  ));
  const names = Object.keys(output).sort((left, right) => {
    if (left === "word/document.xml") return -1;
    if (right === "word/document.xml") return 1;
    return left.localeCompare(right);
  });
  const sections = names.filter((name) => name.endsWith(".xml"))
    .map((name) => textFromWordXml(Buffer.from(output[name]).toString("utf8")))
    .filter(Boolean);
  return {
    text: cleanText(sections.join("\n\n")),
    parser: "docx_ooxml",
    metadata: { section_count: sections.length },
    images: names.filter((name) => /^word\/media\//i.test(name)).slice(0, MAX_EMBEDDED_IMAGES).map((name) => ({
      name,
      mimeType: name.toLowerCase().endsWith(".png") ? "image/png" : name.toLowerCase().endsWith(".webp") ? "image/webp" : name.toLowerCase().endsWith(".gif") ? "image/gif" : "image/jpeg",
      buffer: Buffer.from(output[name]),
    })),
    warnings: [],
  };
}

function archiveTextSection(name, bytes) {
  const text = cleanText(Buffer.from(bytes).toString("utf8"), 30_000);
  return text ? `FILE: ${name}\n${text}` : "";
}

function extractZipArchive(buffer) {
  const included = [];
  const binarySkipped = [];
  const { output, skipped } = zipEntries(buffer, (name) => {
    if (isTextFile(name)) return true;
    binarySkipped.push(name);
    return false;
  });
  for (const name of Object.keys(output).sort()) {
    const section = archiveTextSection(name, output[name]);
    if (section) included.push(section);
  }
  return {
    text: cleanText(included.join("\n\n")),
    parser: "zip_text_archive",
    metadata: {
      included_file_count: included.length,
      skipped_binary_files: binarySkipped.slice(0, 50),
      skipped_large_files: skipped.slice(0, 50),
    },
    warnings: [
      ...(binarySkipped.length ? [`archive_binary_files_skipped:${binarySkipped.length}`] : []),
      ...(skipped.length ? [`archive_large_files_skipped:${skipped.length}`] : []),
    ],
  };
}

function parseTarString(bytes) {
  return Buffer.from(bytes).toString("utf8").split("\u0000", 1)[0].trim();
}

function parseTarSize(bytes) {
  const value = parseTarString(bytes).replace(/^0+/, "") || "0";
  const size = Number.parseInt(value, 8);
  return Number.isFinite(size) && size >= 0 ? size : 0;
}

function extractTarArchive(buffer) {
  const sections = [];
  const skippedBinary = [];
  const skippedLarge = [];
  let entryCount = 0;
  let totalOutputBytes = 0;
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    entryCount += 1;
    if (entryCount > MAX_ARCHIVE_ENTRIES) {
      throw Object.assign(new Error("evidence_archive_too_many_entries"), { status: 422 });
    }
    const name = [parseTarString(header.subarray(345, 500)), parseTarString(header.subarray(0, 100))]
      .filter(Boolean)
      .join("/");
    const size = parseTarSize(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 48);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > buffer.length) throw Object.assign(new Error("evidence_archive_invalid_tar"), { status: 422 });
    if ((type === "0" || type === "\u0000") && name && isTextFile(name)) {
      if (size <= MAX_ARCHIVE_ENTRY_BYTES && totalOutputBytes + size <= MAX_ARCHIVE_OUTPUT_BYTES) {
        const section = archiveTextSection(name, buffer.subarray(bodyStart, bodyEnd));
        if (section) sections.push(section);
        totalOutputBytes += size;
      } else {
        skippedLarge.push(name);
      }
    } else if ((type === "0" || type === "\u0000") && name) {
      skippedBinary.push(name);
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return {
    text: cleanText(sections.join("\n\n")),
    parser: "tar_text_archive",
    metadata: {
      included_file_count: sections.length,
      skipped_binary_files: skippedBinary.slice(0, 50),
      skipped_large_files: skippedLarge.slice(0, 50),
    },
    warnings: [
      ...(skippedBinary.length ? [`archive_binary_files_skipped:${skippedBinary.length}`] : []),
      ...(skippedLarge.length ? [`archive_large_files_skipped:${skippedLarge.length}`] : []),
    ],
  };
}

async function extractPdf(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    disableWorker: true,
    isEvalSupported: false,
    standardFontDataUrl: fileURLToPath(new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url)),
    useSystemFonts: false,
  });
  const document = await loadingTask.promise;
  const pageCount = Math.min(document.numPages, MAX_PDF_PAGES);
  const pages = [];
  const images = [];
  try {
    for (let index = 1; index <= pageCount; index += 1) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => `${String(item?.str || "")}${item?.hasEOL ? "\n" : " "}`)
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .trim();
      if (pageText) pages.push(`[Page ${index}]\n${pageText}`);
      if (index <= MAX_VISUAL_PAGES) {
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(2, 1600 / Math.max(baseViewport.width, baseViewport.height, 1));
        const viewport = page.getViewport({ scale: Math.max(0.75, scale) });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        images.push({ name: `page-${index}.png`, mimeType: "image/png", buffer: canvas.toBuffer("image/png") });
      }
      if (pages.join("\n\n").length >= MAX_EXTRACTED_TEXT_CHARS) break;
    }
  } finally {
    await document.destroy();
  }
  return {
    text: cleanText(pages.join("\n\n")),
    parser: "pdfjs",
    metadata: { page_count: document.numPages, pages_read: pageCount, visual_pages_rendered: images.length },
    images,
    warnings: document.numPages > pageCount ? [`pdf_page_limit_reached:${pageCount}`] : [],
  };
}

export function decodeEvidenceDataUrl(dataUrl = "") {
  const match = /^data:([^,]*),(.*)$/is.exec(String(dataUrl || ""));
  if (!match) throw Object.assign(new Error("evidence_file_invalid_data_url"), { status: 400 });
  const metadata = match[1] || "";
  const mimeType = metadata.split(";", 1)[0].trim().toLowerCase() || "application/octet-stream";
  try {
    const buffer = metadata.toLowerCase().split(";").includes("base64")
      ? Buffer.from(match[2].replace(/\s+/g, ""), "base64")
      : Buffer.from(decodeURIComponent(match[2]), "utf8");
    if (buffer.byteLength > MAX_EVIDENCE_FILE_BYTES) {
      throw Object.assign(new Error("evidence_file_too_large"), { status: 413 });
    }
    return { buffer, mimeType };
  } catch (error) {
    if (error?.status) throw error;
    throw Object.assign(new Error("evidence_file_invalid_data_url"), { status: 400 });
  }
}

export async function extractEvidenceFileContent({ buffer, fileName = "", mimeType = "" } = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const extension = extensionFor(fileName);
  let result;
  if (extension === "pdf" || mimeType === "application/pdf" || bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    result = await extractPdf(bytes);
  } else if (extension === "docx" || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    result = extractDocx(bytes);
  } else if (extension === "zip" || mimeType === "application/zip") {
    result = extractZipArchive(bytes);
  } else if (["tgz", "gz"].includes(extension) || ["application/gzip", "application/x-gzip"].includes(mimeType)) {
    let decompressed;
    try {
      decompressed = Buffer.from(gunzipSync(new Uint8Array(bytes), { out: new Uint8Array(MAX_ARCHIVE_OUTPUT_BYTES) }));
      if (decompressed.byteLength >= MAX_ARCHIVE_OUTPUT_BYTES) {
        throw new Error("decompressed_output_limit_reached");
      }
    } catch {
      throw Object.assign(new Error("evidence_archive_gzip_invalid_or_too_large"), { status: 422 });
    }
    result = extension === "tgz" || fileName.toLowerCase().endsWith(".tar.gz")
      ? extractTarArchive(decompressed)
      : isTextFile(withoutExtension(fileName))
        ? { text: cleanText(decompressed.toString("utf8")), parser: "gzip_text", metadata: {}, warnings: [] }
        : extractTarArchive(decompressed);
  } else if (extension === "tar" || mimeType === "application/x-tar") {
    result = extractTarArchive(bytes);
  } else if (isTextFile(fileName, mimeType)) {
    result = { text: cleanText(bytes.toString("utf8")), parser: "utf8_text", metadata: {}, warnings: [] };
  } else {
    throw Object.assign(new Error(`evidence_file_type_unsupported:${extension || mimeType || "unknown"}`), { status: 415 });
  }

  if (!result.text && !(result.images || []).length) {
    throw Object.assign(new Error(`evidence_file_no_extractable_text:${result.parser}`), { status: 422 });
  }
  return result;
}

export async function extractEvidenceFileText(options = {}) {
  const result = await extractEvidenceFileContent(options);
  if (!result.text) throw Object.assign(new Error(`evidence_file_no_extractable_text:${result.parser}`), { status: 422 });
  return result;
}
