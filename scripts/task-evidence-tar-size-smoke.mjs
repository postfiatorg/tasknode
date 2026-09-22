import assert from "node:assert/strict";
import { extractEvidenceFileContent } from "../server/evidence-file-extraction.js";

function tarEntry(name, body, sizeField = `${body.length.toString(8).padStart(11, "0")}\0`, type = "0") {
  assert.equal(Buffer.byteLength(sizeField, "latin1"), 12);
  const header = Buffer.alloc(512);
  header.write(name, 0, "ascii");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(sizeField, 124, "latin1");
  header.write("00000000000\0", 136, "ascii");
  header.fill(32, 148, 156);
  header.write(type, 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  const content = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512)]);
}

function archive(...entries) {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

async function extract(bytes) {
  return extractEvidenceFileContent({ buffer: bytes, fileName: "proof.tar", mimeType: "application/x-tar" });
}

const valid = await extract(archive(tarEntry("proof.txt", "hello")));
assert.equal(valid.text, "FILE: proof.txt\nhello");

for (const sizeField of [
  "00000000005x", // parseInt accepts the octal prefix and ignores x
  "000000000058", // invalid octal digit
  "0000000005\0x", // non-padding byte after NUL
  "0000000000-1", // signed-like suffix
  "           \0", // no octal digit
]) {
  await assert.rejects(
    extract(archive(tarEntry("proof.txt", "hello", sizeField))),
    (error) => error.message === "evidence_archive_invalid_tar_size" && error.status === 422,
    `malformed size ${JSON.stringify(sizeField)} must fail closed`,
  );
}

const padded = await extract(archive(tarEntry("proof.txt", "hello", "     000005\0")));
assert.equal(padded.text, valid.text);

const spaceTerminated = await extract(archive(tarEntry("proof.txt", "hello", "00000000005 ")));
assert.equal(spaceTerminated.text, valid.text);

const blankDirectory = await extract(archive(
  tarEntry("docs/", "", "\0".repeat(12), "5"),
  tarEntry("docs/proof.txt", "hello"),
));
assert.equal(blankDirectory.text, "FILE: docs/proof.txt\nhello");

await assert.rejects(
  extract(archive(tarEntry("proof.txt", "hello", "\0".repeat(12)))),
  (error) => error.message === "evidence_archive_invalid_tar_size" && error.status === 422,
  "blank regular-file size must fail closed",
);

await assert.rejects(
  extract(archive(tarEntry("proof.txt", "hello", `${String.fromCharCode(128)}${"\0".repeat(11)}`))),
  (error) => error.message === "evidence_archive_invalid_tar_size" && error.status === 422,
  "unsupported base-256 size must fail closed",
);

const zero = await extract(archive(tarEntry("empty.txt", ""), tarEntry("proof.txt", "hello")));
assert.equal(zero.text, "FILE: proof.txt\nhello");

const large = await extract(archive(
  tarEntry("large.txt", Buffer.alloc(1_500_001, 97)),
  tarEntry("proof.txt", "hello"),
));
assert.equal(large.text, "FILE: proof.txt\nhello");
assert.deepEqual(large.warnings, ["archive_large_files_skipped:1"]);

console.log("task-evidence-tar-size: 13 PASS");
