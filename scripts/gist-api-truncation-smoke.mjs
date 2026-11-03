import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const sourceRoot = process.env.SOURCE_ROOT || fileURLToPath(new URL("../", import.meta.url));
const { fetchUrlExcerpt } = await import(pathToFileURL(`${sourceRoot}/server/task-review-evidence.js`));
const calls = [];
const input = "https://gist.github.com/synthetic/abcdef123456";
const fixture = {
  description: "Synthetic API truncation QA",
  files: {
    "REPORT.md": {
      filename: "REPORT.md", content: "SYNTHETIC-PREFIX", truncated: false,
      raw_url: "http://127.0.0.1/must-never-fetch",
    },
  },
};
async function resolve(truncated) {
  const body = structuredClone(fixture);
  body.files["REPORT.md"].truncated = truncated;
  const result = await fetchUrlExcerpt(input, {
    lookupFn: async () => [{ address: "140.82.112.133", family: 4 }],
    fetchImpl: async (url) => {
      calls.push(String(url));
      assert.equal(String(url), "https://api.github.com/gists/abcdef123456", "raw_url must never be fetched");
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(result.status, "extracted");
  return result;
}
const complete = await resolve(false);
const expected = "GIST MANIFEST: 1 text file(s) included\n\nFILE: REPORT.md | original_chars=16 | included_chars=16\nSYNTHETIC-PREFIX";
assert.equal(complete.excerpt, expected, "non-truncated result remains byte-identical");
assert.equal((await resolve(undefined)).excerpt, expected, "absent flag retains existing behavior");
const partial = await resolve(true);
console.log(JSON.stringify({ input, api_file: { ...fixture.files["REPORT.md"], truncated: true }, complete, partial, calls }));
assert.ok(partial.excerpt.includes("[GitHub API truncated: source length unknown; content is a partial prefix]"), "API truncation must be disclosed");
assert.ok(partial.excerpt.includes("api_prefix_chars=16 | included_chars=16"), "prefix length must be labeled honestly");
assert.ok(!partial.excerpt.includes("original_chars=16"), "prefix length must not claim full source length");
assert.equal(calls.length, 3);
console.log(`PASS: false/absent flag unchanged SHA256=${createHash("sha256").update(expected).digest("hex")}; true flag disclosed; no raw_url fetch`);
