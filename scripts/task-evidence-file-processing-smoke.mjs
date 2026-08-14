#!/usr/bin/env node
import assert from "node:assert/strict";
import { gzipSync, zipSync, strToU8 } from "fflate";

import { processEvidenceFileForSubmission } from "../server/task-evidence-processing.js";
import {
  buildTaskSubmissionPayloadForTests,
  readEvidenceFile,
} from "../src/features/tasks/task-submission-actions.js";

function dataUrl(bytes, mimeType) {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

async function processFile({ bytes, name, type }) {
  return processEvidenceFileForSubmission({
    file: {
      dataUrl: dataUrl(bytes, type),
      name,
      size: bytes.length,
      type,
    },
    method: "file",
    value: name,
    env: { AMBIENT_API_KEY: "evidence-file-smoke" },
    fetchImpl: async () => new Response(JSON.stringify({
      id: "ambient_vision_document_smoke",
      model: "moonshotai/kimi-k2.7-code",
      choices: [{ message: { content: "The rendered page visibly contains the verification evidence text." } }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
}

function sampleDocx() {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>General DOCX verification evidence</w:t></w:r></w:p>
        <w:p><w:r><w:t>This extracted text must reach reward scoring.</w:t></w:r></w:p>
      </w:body>
    </w:document>`;
  return zipSync({
    "[Content_Types].xml": strToU8("<Types />"),
    "word/document.xml": strToU8(xml),
    "word/media/screenshot.png": new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nUwAAAAASUVORK5CYII=", "base64")),
  });
}

function samplePdf() {
  const lines = ["General PDF verification evidence", "This PDF text must reach reward scoring."];
  const stream = Buffer.from([
    "BT",
    "/F1 13 Tf",
    "72 740 Td",
    ...lines.flatMap((line, index) => [index ? "0 -22 Td" : "", `(${line}) Tj`].filter(Boolean)),
    "ET",
  ].join("\n"), "latin1");
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from("\nendstream")]),
  ];
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [];
  let length = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    chunks.push(chunk);
    length += chunk.length;
  }
  const xrefOffset = length;
  chunks.push(Buffer.from([
    `xref\n0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>`,
    `startxref\n${xrefOffset}`,
    "%%EOF",
    "",
  ].join("\n")));
  return Buffer.concat(chunks);
}

{
  const docx = sampleDocx();
  const browserRead = await readEvidenceFile({
    arrayBuffer: async () => docx.buffer.slice(docx.byteOffset, docx.byteOffset + docx.byteLength),
    name: "work-evidence.docx",
    size: docx.length,
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  assert.match(browserRead.dataUrl, /^data:application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document;base64,/);

  const result = await processFile({
    bytes: docx,
    name: "work-evidence.docx",
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  assert.equal(result.processing.status, "extracted");
  assert.equal(result.processing.parser, "docx_ooxml");
  assert.match(result.text, /General DOCX verification evidence/);
  assert.match(result.text, /reach reward scoring/);
  assert.match(result.text, /rendered page visibly contains/);
  assert.equal(result.processing.metadata.visual_observation_count, 1);

  const payload = await buildTaskSubmissionPayloadForTests({
    detail: { actions: { canSubmitVerificationEvidence: true } },
    linkedWalletAddress: "rEvidenceWallet",
    notes: "Document attached.",
    task: { taskId: "task_document_regression" },
    evidenceItems: [{
      draftReady: true,
      method: "file",
      notes: "Document attached.",
      value: "work-evidence.docx",
      file: {
        ...browserRead,
        text: result.text,
        processing: result.processing,
      },
    }],
  });
  assert.match(payload.response_text, /General DOCX verification evidence/);
  assert.equal(payload.evidence_items[0].file.processing.status, "extracted");
  assert.equal(payload.evidence_items[0].file.processing.parser, "docx_ooxml");
}

{
  const pdf = samplePdf();
  const result = await processFile({ bytes: pdf, name: "work-evidence.pdf", type: "application/pdf" });
  assert.equal(result.processing.status, "extracted");
  assert.equal(result.processing.parser, "pdfjs");
  assert.match(result.text, /General PDF verification evidence/);
  assert.match(result.text, /reach reward scoring/);
  assert.match(result.text, /rendered page visibly contains/);
  assert.equal(result.processing.metadata.visual_observation_count, 1);
}

{
  const archive = zipSync({
    "README.md": strToU8("Archive verification overview and acceptance proof."),
    "src/implementation.js": strToU8("export const documentProcessingFixed = true;"),
    "assets/binary.png": new Uint8Array([137, 80, 78, 71]),
  });
  const result = await processFile({ bytes: archive, name: "delivery.zip", type: "application/zip" });
  assert.equal(result.processing.status, "extracted");
  assert.equal(result.processing.parser, "zip_text_archive");
  assert.match(result.text, /FILE: README\.md/);
  assert.match(result.text, /documentProcessingFixed/);
  assert.deepEqual(result.processing.metadata.skipped_binary_files, ["assets/binary.png"]);
}

{
  const archive = gzipSync(strToU8("Compressed verification notes remain readable."));
  const result = await processFile({ bytes: archive, name: "notes.txt.gz", type: "application/gzip" });
  assert.equal(result.processing.status, "extracted");
  assert.equal(result.processing.parser, "gzip_text");
  assert.match(result.text, /Compressed verification notes remain readable/);
}

{
  await assert.rejects(
    () => processFile({ bytes: Buffer.from([0, 1, 2]), name: "opaque.bin", type: "application/octet-stream" }),
    /evidence_file_type_unsupported/
  );
}

console.log("task evidence file processing smoke ok");
