#!/usr/bin/env node
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { closePool, transactionCommand, query } from "../server/db/pool.js";
import { upsertIndex } from "../server/repositories/index-viewer.js";

const args = process.argv.slice(2);
const value = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : "";
if (args.includes("--help")) {
  console.log("Usage: node scripts/publish-validator-bundle.mjs --directory /private/static-export --id ga-models --title 'GoodAlexander models' [--summary TEXT] [--publish]\nDefault: validate only. --publish writes an encrypted bundle and validator-tier catalog entry to DATABASE_URL. No plaintext files are written to the repository.");
} else {
  const directory = path.resolve(value("--directory"));
  const indexId = value("--id");
  if (!value("--directory") || !indexId || ![...indexId].every((c) => "abcdefghijklmnopqrstuvwxyz0123456789-".includes(c))) throw new Error("directory_and_safe_id_required");
  const files = {};
  let totalBytes = 0;
  async function visit(relative = "") {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      if (["EXPORT.md", "MANIFEST.sha256"].includes(entry.name)) continue;
      if (entry.name.startsWith(".")) throw new Error("hidden_files_not_allowed_in_bundle");
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) {
        if (!["html", "js", "css", "md", "json", "csv", "svg", "png", "jpg", "jpeg", "webp", "ico", "woff", "woff2", "txt"].includes(entry.name.split(".").at(-1).toLowerCase())) throw new Error(`unsupported_bundle_file:${name}`);
        const bytes = await readFile(path.join(directory, name));
        totalBytes += bytes.length;
        if (totalBytes > 64 * 1024 * 1024) throw new Error("bundle_exceeds_64_mib");
        files[name] = bytes.toString("base64");
      } else throw new Error("bundle_symlinks_forbidden");
    }
  }
  try {
    await visit();
    if (!files["index.html"]) throw new Error("bundle_index_html_required");
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const compressed = gzipSync(Buffer.from(JSON.stringify({ version: 1, files })));
    const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const bytes = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    if (args.includes("--publish")) await transactionCommand(async () => {
      await upsertIndex({ indexId, title: value("--title") || indexId, summary: value("--summary"), tier: "validator",
        contentKey: key.toString("base64"), contentHash, contentUrl: `/api/index-viewer/indices/${indexId}/content`,
        metadata: { format: "tasknode-encrypted-static-v1", viewerUrl: `/api/research/bundles/${indexId}/index.html` } });
      await query(`INSERT INTO index_viewer_bundles(index_id,encrypted_bytes) VALUES($1,$2)
        ON CONFLICT(index_id) DO UPDATE SET encrypted_bytes=EXCLUDED.encrypted_bytes,updated_at=now()`, [indexId, bytes]);
    });
    console.log(JSON.stringify({ ok: true, published: args.includes("--publish"), indexId, fileCount: Object.keys(files).length, totalBytes, encryptedBytes: bytes.length, contentHash }));
  } finally { await closePool(); }
}
