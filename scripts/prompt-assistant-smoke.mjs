import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateDocsAssistantResponse, generateDocsOdvResponse } from "../server/docs-odv.js";
let called = false;
const deps = {
  authorize: async () => ({ ok: true, document: { documentType: "prompt" } }),
  infer: async () => {
    called = true;
  },
  loadUserContext: async () => {
    called = true;
  },
};
for (const fn of [generateDocsAssistantResponse, generateDocsOdvResponse]) {
  assert.equal(
    (await fn({ prompt: "@ODV synthetic canary", documentContent: "synthetic canary", includeFullContext: true }, deps))
      .status,
    403,
  );
}
assert.equal(called, false);
const ui = await readFile(new URL("../src/features/docs-library/DocsLibraryView.jsx", import.meta.url), "utf8");
assert.ok(
  ui.indexOf('if (activeEditor.documentType === "prompt") return;') <
    ui.indexOf("void requestJson(`/api/docs/documents/${activeEditor.documentId}"),
);
assert.match(ui, /activeEditor.documentType !== "prompt" && collaboration.docsOdvEnabled/);
const routes = await readFile(new URL("../server/collaboration-routes.js", import.meta.url), "utf8");
for (const name of ["odv", "assistant"]) {
  const block = routes.slice(routes.indexOf(`if (${name}Match)`));
  assert.ok(block.indexOf("rejectPromptAssistant") < block.indexOf("readJson(req"));
}
console.log(
  "PASS prompt assistant isolation: both inference paths denied, no context/provider call, browser and route guards",
);
