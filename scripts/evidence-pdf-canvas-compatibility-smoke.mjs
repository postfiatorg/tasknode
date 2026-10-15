#!/usr/bin/env node
// Actual bounded extraction with generated public-safe bytes; no submission/signing graph.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { zipSync, strToU8 } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const violations = [];
const loadedApplication = new Set();
const allowed = new Set(["server/evidence-file-extraction.js", "server/inference-text.js", "shared/text-protocol.js"]);
const deny = (value) => { violations.push(value); throw new Error(`Forbidden runtime: ${value}`); };
globalThis.fetch = () => deny("network fetch");
process.env.DISABLE_SYSTEM_FONTS_LOAD = "1";
registerHooks({
  resolve(specifier, context, next) {
    if (/^(?:node:)?(?:net|tls|dgram|http|https|http2|child_process)$/.test(specifier) || /^(?:xrpl|ripple-|@scure|@noble)/.test(specifier)) deny(specifier);
    const result = next(specifier, context);
    if (result.url.startsWith(pathToFileURL(root + path.sep).href)) {
      const relative = path.relative(root, fileURLToPath(result.url)).split(path.sep).join("/");
      if (/^(?:src|server|shared)\//.test(relative)) {
        if (!allowed.has(relative)) deny(`application:${relative}`);
        loadedApplication.add(relative);
      }
    }
    return result;
  },
});
const { extractEvidenceFileContent, decodeEvidenceDataUrl, MAX_EVIDENCE_FILE_BYTES, MAX_EXTRACTED_TEXT_CHARS } = await import(pathToFileURL(path.join(root, "server/evidence-file-extraction.js")).href);

// Build a small self-contained PDF, without external files, URLs or generated evidence commits.
function pdfFixture(count = 1, { width = 300, height = 200, text = "Synthetic canvas compatibility evidence", shape = true } = {}) {
  const pageIds = Array.from({ length: count }, (_, index) => 4 + index * 2);
  const objects = [Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"), Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${count} >>`), Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")];
  for (let index = 0; index < count; index++) {
    const id = pageIds[index];
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`));
    const safe = `${text} page ${index + 1}`.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
    const stream = Buffer.from([shape ? "0 0 0 rg 20 20 40 30 re f" : "", "BT /F1 12 Tf 20 120 Td", `(${safe}) Tj`, "ET"].filter(Boolean).join("\n"), "latin1");
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from("\nendstream")]));
  }
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [];
  let length = chunks[0].length;
  for (let index = 0; index < objects.length; index++) {
    offsets.push(length);
    const bytes = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), objects[index], Buffer.from("\nendobj\n")]);
    chunks.push(bytes); length += bytes.length;
  }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
function extract(buffer, more = {}) {
  return extractEvidenceFileContent({ buffer, fileName: "synthetic.pdf", mimeType: "application/pdf", ...more });
}
function pngDimensions(bytes) {
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}
async function pixelEvidence(bytes) {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  try {
    const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    let dark = 0, white = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 200 && data[i] < 150 && data[i + 1] < 150 && data[i + 2] < 150) dark++;
      if (data[i + 3] > 200 && data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245) white++;
    }
    assert.ok(dark > 100, "rendered shape/text must have real dark pixels"); assert.ok(white > 100, "page must have white background pixels");
    return { dark, white, width: image.width, height: image.height };
  } finally { canvas.width = 0; canvas.height = 0; }
}
const results = [];
async function test(id, body) {
  let error = null, detail = null;
  try { detail = await body(); assert.deepEqual(violations, []); }
  catch (failure) { error = `${failure.name}: ${String(failure.message).split("\n")[0]}`.replaceAll(root, "<checkout>").slice(0, 800); }
  results.push({ id, pass: error === null, error, detail });
  console.log(`${error ? "FAIL" : "PASS"} ${id}${error ? `: ${error}` : ""}`);
}

await test("native-one-page-text-and-visible-PNG", async () => {
  const out = await extract(pdfFixture());
  assert.equal(out.parser, "pdfjs"); assert.match(out.text, /Synthetic canvas compatibility evidence page 1/);
  assert.equal(out.metadata.page_count, 1); assert.equal(out.metadata.visual_pages_rendered, 1); assert.equal(out.images.length, 1);
  assert.deepEqual(pngDimensions(out.images[0].buffer), [600, 400]);
  const pixels = await pixelEvidence(out.images[0].buffer);
  if (process.env.PDF_CANVAS_PREVIEW) writeFileSync(process.env.PDF_CANVAS_PREVIEW, out.images[0].buffer);
  return { parser: out.parser, pngBytes: out.images[0].buffer.length, pixels };
});
await test("five-pages-retain-text-and-four-visual-cap", async () => {
  const out = await extract(pdfFixture(5));
  assert.equal(out.metadata.page_count, 5); assert.equal(out.metadata.pages_read, 5); assert.equal(out.images.length, 4);
  assert.match(out.text, /page 5/); assert.deepEqual(out.images.map((image) => image.name), ["page-1.png", "page-2.png", "page-3.png", "page-4.png"]);
  for (const image of out.images) assert.deepEqual(pngDimensions(image.buffer), [600, 400]);
  return out.metadata;
});
await test("wide-page-dimensions-and-pixel-content", async () => {
  const out = await extract(pdfFixture(1, { width: 1200, height: 200 }));
  assert.deepEqual(pngDimensions(out.images[0].buffer), [1600, 267]);
  return pixelEvidence(out.images[0].buffer);
});
await test("PDF-sniff-routing-without-PDF-extension", async () => {
  const out = await extract(pdfFixture(), { fileName: "synthetic.bin", mimeType: "application/octet-stream" });
  assert.equal(out.parser, "pdfjs"); assert.equal(out.images.length, 1);
});
await test("PDF-250-text-page-cap-with-four-visuals", async () => {
  const out = await extract(pdfFixture(251, { text: "bounded" }));
  assert.equal(out.metadata.page_count, 251); assert.equal(out.metadata.pages_read, 250); assert.equal(out.images.length, 4);
  assert.match(out.text, /page 250/); assert.doesNotMatch(out.text, /page 251/); assert.ok(out.warnings.includes("pdf_page_limit_reached:250"));
  return out.metadata;
});
await test("malformed-PDF-rejected", async () => assert.rejects(extract(Buffer.from("%PDF-not-a-document"))));
await test("truncated-PDF-rejected", async () => assert.rejects(extract(pdfFixture().subarray(0, 100))));
await test("oversized-data-URL-rejected-before-render", async () => {
  const uri = `data:application/pdf;base64,${Buffer.alloc(MAX_EVIDENCE_FILE_BYTES + 1).toString("base64")}`;
  assert.throws(() => decodeEvidenceDataUrl(uri), (failure) => failure.status === 413 && failure.message === "evidence_file_too_large");
});
await test("exact-byte-data-URL-admitted", async () => {
  const uri = `data:application/octet-stream;base64,${Buffer.alloc(MAX_EVIDENCE_FILE_BYTES).toString("base64")}`;
  assert.equal(decodeEvidenceDataUrl(uri).buffer.length, MAX_EVIDENCE_FILE_BYTES);
});
await test("malformed-data-URL-rejected", async () => assert.throws(() => decodeEvidenceDataUrl("not-a-data-url"), (failure) => failure.status === 400));
await test("DOCX-text-neighbor-retained", async () => {
  const xml = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic DOCX control</w:t></w:r></w:p></w:body></w:document>';
  const bytes = zipSync({ "[Content_Types].xml": strToU8("<Types />"), "word/document.xml": strToU8(xml) });
  const out = await extractEvidenceFileContent({ buffer: bytes, fileName: "synthetic.docx" });
  assert.equal(out.parser, "docx_ooxml"); assert.match(out.text, /Synthetic DOCX control/);
});
await test("ZIP-text-and-binary-skip-neighbor", async () => {
  const bytes = zipSync({ "README.md": strToU8("Synthetic archive control"), "binary.png": new Uint8Array([137, 80, 78, 71]) });
  const out = await extractEvidenceFileContent({ buffer: bytes, fileName: "synthetic.zip" });
  assert.equal(out.parser, "zip_text_archive"); assert.match(out.text, /Synthetic archive control/); assert.ok(out.warnings.some((value) => value.includes("binary")));
});
await test("DOCX-DOCTYPE-still-refused", async () => {
  const bytes = zipSync({ "word/document.xml": strToU8('<!DOCTYPE x><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>') });
  await assert.rejects(extractEvidenceFileContent({ buffer: bytes, fileName: "synthetic.docx" }), /doctype_unsupported/);
});
await test("unsupported-file-still-refused", async () => assert.rejects(extractEvidenceFileContent({ buffer: Buffer.from([0, 1, 2]), fileName: "synthetic.unknown" }), (failure) => failure.status === 415));
await test("text-cap-and-truncation-note-retained", async () => {
  const out = await extractEvidenceFileContent({ buffer: Buffer.from("x".repeat(MAX_EXTRACTED_TEXT_CHARS + 1)), fileName: "synthetic.txt" });
  assert.equal(out.parser, "utf8_text"); assert.equal(out.text.slice(0, MAX_EXTRACTED_TEXT_CHARS), "x".repeat(MAX_EXTRACTED_TEXT_CHARS)); assert.match(out.text, /extracted_text_truncated/);
});

// Observe real factory/document cleanup, including an encoder failure after rendering.
async function cleanupControl(encodeFailure) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const probe = await pdfjs.getDocument({ data: new Uint8Array(pdfFixture()), disableWorker: true, isEvalSupported: false }).promise;
  const factoryPrototype = Object.getPrototypeOf(probe.canvasFactory);
  const documentPrototype = Object.getPrototypeOf(probe);
  const originalCreate = factoryPrototype.create;
  const originalDestroy = factoryPrototype.destroy;
  const originalDocumentDestroy = documentPrototype.destroy;
  const ownCreate = Object.hasOwn(factoryPrototype, "create");
  const ownDestroy = Object.hasOwn(factoryPrototype, "destroy");
  await probe.destroy();
  const surfaces = [];
  let documentDestroys = 0;
  factoryPrototype.create = function (width, height) {
    const surface = originalCreate.call(this, width, height);
    if (width === 600 && height === 400) {
      surfaces.push({ surface, canvas: surface.canvas, released: false });
      if (encodeFailure) surface.canvas.toBuffer = () => { throw new Error("synthetic_encode_failure"); };
    }
    return surface;
  };
  factoryPrototype.destroy = function (surface) {
    const tracked = surfaces.find((row) => row.surface === surface);
    try { return originalDestroy.call(this, surface); }
    finally {
      if (tracked) {
        tracked.released = surface.canvas === null && surface.context === null;
        tracked.nativeResetSize = [tracked.canvas.width, tracked.canvas.height];
      }
    }
  };
  documentPrototype.destroy = function (...args) { documentDestroys++; return originalDocumentDestroy.apply(this, args); };
  try {
    if (encodeFailure) await assert.rejects(extract(pdfFixture()), /synthetic_encode_failure/);
    else await extract(pdfFixture());
    assert.equal(surfaces.length, 1, "page surface must come from the PDF.js-owned factory");
    assert.ok(surfaces[0].released, "page surface references must be released in finally");
    // Both locked native backends reset a zero dimension to their default.
    assert.deepEqual(surfaces[0].nativeResetSize, [350, 150]);
    assert.equal(documentDestroys, 1, "document cleanup must survive both paths");
    return { pageSurfaces: surfaces.length, released: true, nativeResetSize: surfaces[0].nativeResetSize, documentDestroys, encodeFailure };
  } finally {
    if (ownCreate) factoryPrototype.create = originalCreate; else delete factoryPrototype.create;
    if (ownDestroy) factoryPrototype.destroy = originalDestroy; else delete factoryPrototype.destroy;
    documentPrototype.destroy = originalDocumentDestroy;
  }
}
await test("real-factory-and-document-cleanup-success", async () => cleanupControl(false));
await test("real-factory-and-document-cleanup-encode-failure", async () => cleanupControl(true));

const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const report = { cases: results.length, passed: results.filter((row) => row.pass).length, failed: results.filter((row) => !row.pass).length, results, boundaryViolations: violations, loadedApplication: [...loadedApplication].sort(), nativeVersions: Object.fromEntries(["node_modules/@napi-rs/canvas", "node_modules/pdfjs-dist", "node_modules/pdfjs-dist/node_modules/@napi-rs/canvas"].map((key) => [key, lock.packages[key]?.version ?? "deduplicated"])), node: process.version, scope: "Actual extraction + native PDF/canvas, synthetic fixture bytes only; no full frontend/submission/server, wallet/signing/provider/ledger/operator runtime" };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ cases: report.cases, passed: report.passed, failed: report.failed, boundaryViolations: violations.length }));
if (report.failed || violations.length) process.exitCode = 1;
