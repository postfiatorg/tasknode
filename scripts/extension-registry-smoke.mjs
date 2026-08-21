#!/usr/bin/env node
import assert from "node:assert/strict";
import { createTaskNodeExtensionRegistry, defineTaskNodeExtension } from "../src/extensions/registry.js";

const component = () => null;
const registry = createTaskNodeExtensionRegistry([
  { id: "later-tool", label: "Later", component, group: "insight", order: 20 },
  { id: "gated-tool", label: "Gated", component, group: "insight", order: 10, enabled: ({ enabled }) => enabled },
]);

assert.deepEqual(registry.inventory().map(({ id }) => id), ["gated-tool", "later-tool"]);
assert.deepEqual(registry.menu("more", "insight", { enabled: false }).map(({ id }) => id), ["later-tool"]);
assert.deepEqual(registry.menu("more", "insight", { enabled: true }).map(({ id }) => id), ["gated-tool", "later-tool"]);
assert.equal(registry.forView("later-tool")?.label, "Later");
assert.equal(Object.isFrozen(defineTaskNodeExtension({ id: "frozen-tool", label: "Frozen", component })), true);
assert.throws(() => defineTaskNodeExtension({ id: "../escape", label: "Escape", component }), /tasknode_extension_id_invalid/);
assert.throws(() => createTaskNodeExtensionRegistry([
  { id: "same-tool", label: "One", component },
  { id: "same-tool", label: "Two", component },
]), /tasknode_extension_duplicate/);

console.log("extension registry smoke ok: validation, ordering, feature gates, and duplicate rejection verified");
