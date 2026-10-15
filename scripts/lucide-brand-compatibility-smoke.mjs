#!/usr/bin/env node
// Static import contract plus isolated real React/Lucide component rendering.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as lucide from "lucide-react";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(path.join(root, "scripts/fixtures/lucide-github-0.562.0.json"), "utf8"));
const violations = [];
const deny = (message) => { violations.push(message); throw new Error(`Forbidden runtime: ${message}`); };
globalThis.fetch = () => deny("fetch");
registerHooks({
  resolve(specifier, context, next) {
    if (/^(?:node:)?(?:net|tls|dgram|http|https|http2|crypto|child_process)$/.test(specifier) || /^(?:xrpl|ripple-|@scure|@noble)/.test(specifier)) deny(specifier);
    const result = next(specifier, context);
    const sourcePrefix = pathToFileURL(path.join(root, "src") + path.sep).href;
    if (result.url.startsWith(sourcePrefix) && result.url !== pathToFileURL(path.join(root, "src/components/GithubIcon.js")).href) deny("application module outside isolated icon");
    return result;
  },
});

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(filename) : /\.(?:jsx?|tsx?)$/.test(entry.name) ? [filename] : [];
  });
}
const inventory = [];
for (const filename of sources(path.join(root, "src"))) {
  const text = readFileSync(filename, "utf8");
  for (const match of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']lucide-react["']/gs)) {
    const names = match[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    inventory.push({ file: path.relative(root, filename), names, missing: names.filter((name) => !(name in lucide)) });
  }
}
const callers = ["src/features/identity/IdentityControls.jsx", "src/features/settings/AppDialogs.jsx", "src/features/tasks/TaskDetailPanels.jsx"];
let Github;
if (existsSync(path.join(root, "src/components/GithubIcon.js"))) {
  ({ Github } = await import(pathToFileURL(path.join(root, "src/components/GithubIcon.js")).href));
}
const results = [];
function test(id, body) {
  let error = null;
  try { body(); assert.deepEqual(violations, []); } catch (failure) { error = `${failure.name}: ${String(failure.message).split("\n")[0]}`.replaceAll(root, "<checkout>").slice(0, 600); }
  results.push({ id, pass: error === null, error });
  console.log(`${error ? "FAIL" : "PASS"} ${id}${error ? `: ${error}` : ""}`);
}
function markup(props = {}, child) {
  assert.ok(Github, "local Github icon module is unavailable");
  return renderToStaticMarkup(createElement(Github, props, child));
}
function attribute(svg, name) {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(svg)?.[1];
}
function geometry(svg) {
  return [...svg.matchAll(/<path\s[^>]*d="([^"]+)"/g)].map((match) => match[1]);
}

test("all-application-Lucide-imports-resolve", () => {
  const missing = inventory.filter((row) => row.missing.length);
  assert.deepEqual(missing, [], JSON.stringify(missing));
});
for (const filename of callers) test(`local-brand-module-at-${filename}`, () => {
  const text = readFileSync(path.join(root, filename), "utf8");
  assert.match(text, /import\s*\{\s*Github\s*\}\s*from\s*["']\.\.\/\.\.\/components\/GithubIcon(?:\.js)?["']/);
});
test("retained-GitHub-path-geometry", () => assert.deepEqual(geometry(markup()), fixture.iconNode.map(([, attrs]) => attrs.d)));
test("default-layout-and-paint", () => {
  const svg = markup();
  for (const [key, value] of Object.entries({ width: "24", height: "24", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" })) assert.equal(attribute(svg, key), value, key);
});
test("existing-provider-size-and-stroke", () => {
  const svg = markup({ size: 20, strokeWidth: 1.9 });
  assert.equal(attribute(svg, "width"), "20"); assert.equal(attribute(svg, "height"), "20"); assert.equal(attribute(svg, "stroke-width"), "1.9");
});
test("task-icon-class-and-custom-size", () => {
  const svg = markup({ size: 16, className: "task-commit-icon" });
  assert.equal(attribute(svg, "width"), "16"); assert.match(attribute(svg, "class"), /lucide-github/); assert.match(attribute(svg, "class"), /task-commit-icon/);
});
test("color-style-and-DOM-props-forwarded", () => {
  const svg = markup({ color: "red", style: { opacity: 0.5 }, "data-testid": "brand-icon", id: "github-mark" });
  assert.equal(attribute(svg, "stroke"), "red"); assert.equal(attribute(svg, "style"), "opacity:0.5"); assert.equal(attribute(svg, "data-testid"), "brand-icon"); assert.equal(attribute(svg, "id"), "github-mark");
});
test("default-decorative-icon-hidden", () => assert.equal(attribute(markup(), "aria-hidden"), "true"));
test("accessible-label-and-role-forwarded", () => {
  const svg = markup({ "aria-label": "GitHub", role: "img" });
  assert.equal(attribute(svg, "aria-label"), "GitHub"); assert.equal(attribute(svg, "role"), "img"); assert.notEqual(attribute(svg, "aria-hidden"), "true");
});
test("accessible-labelledby-forwarded", () => {
  const svg = markup({ "aria-labelledby": "github-title" });
  assert.equal(attribute(svg, "aria-labelledby"), "github-title"); assert.notEqual(attribute(svg, "aria-hidden"), "true");
});
test("title-child-retained", () => {
  const svg = markup({}, createElement("title", null, "GitHub"));
  assert.match(svg, /<title>GitHub<\/title>/); assert.notEqual(attribute(svg, "aria-hidden"), "true");
});
test("absolute-stroke-width-contract", () => {
  const svg = markup({ size: 48, strokeWidth: 2, absoluteStrokeWidth: true });
  assert.equal(attribute(svg, "stroke-width"), "1");
});
test("source-retains-license-attribution", () => {
  const notices = readFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.match(notices, /GithubIcon/); assert.match(notices, /0\.562\.0/);
  const license = readFileSync(path.join(root, "src/components/lucide-github-LICENSE.txt"), "utf8");
  assert.match(license, /ISC License/); assert.match(license, /Lucide Contributors 2025/); assert.match(license, /The MIT License/);
  const provenance = JSON.parse(readFileSync(path.join(root, "provenance/assets.json"), "utf8"));
  const entry = provenance.sourceComponents?.find((item) => item.path === "src/components/GithubIcon.js");
  assert.ok(entry, "CONTRIBUTING requires third-party source provenance in assets.json");
  assert.equal(entry.source, fixture.source); assert.equal(entry.sourceFile, fixture.sourceFile);
  assert.equal(entry.upstreamGlyphSha256, fixture.glyphSha256);
  assert.equal(entry.licenseFile, "src/components/lucide-github-LICENSE.txt"); assert.match(entry.terms, /ISC/);

});

const report = { cases: results.length, passed: results.filter((row) => row.pass).length, failed: results.filter((row) => !row.pass).length, boundaryViolations: violations, node: process.version, inventory, uniqueImportedSymbols: [...new Set(inventory.flatMap((row) => row.names))].sort(), results, scope: "Static import surface and isolated actual React/Lucide local icon; no full app/server, wallet/key/crypto/signing/provider/ledger runtime", dedicatedProjectTypecheck: "No typecheck script exists; actual export-resolution check plus Vite module build, not a claimed full TypeScript check" };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ cases: report.cases, passed: report.passed, failed: report.failed, boundaryViolations: violations.length }));
if (report.failed || violations.length) process.exitCode = 1;
