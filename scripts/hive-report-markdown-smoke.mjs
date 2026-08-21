import assert from "node:assert/strict";
import { normalizeHiveReportMarkdown, parseMarkdownBlocks } from "../src/features/hive/hive-report-markdown.js";

const collapsedOperativeReport = [
  "Operative Report - Task Node Hive",
  "*Generated 2026-06-26 21:13 UTC*",
  "",
  "---",
  "",
  "Network Snapshot",
  "| Metric | Value | |---|---| | Active projects | 5 | | Operatorsonline | 33 | | Tasks in flight | 35 |",
  "",
  "Active Projects",
  "| Project | Type | Priority | Tasks | |---|---|---|---| | Task Node Core Product | Protocol Applications | 10 | 323 | | Market Alpha Tasks | Alpha Generation | 20 | 8 |",
].join("\n");

const normalized = normalizeHiveReportMarkdown(collapsedOperativeReport);
assert.match(normalized, /\| Metric \| Value \|\n\|---\|---\|\n\| Active projects \| 5 \|/);
assert.match(normalized, /\| Project \| Type \| Priority \| Tasks \|\n\|---\|---\|---\|---\|/);

const blocks = parseMarkdownBlocks(collapsedOperativeReport);
const headings = blocks.filter((block) => block.type === "heading").map((block) => block.text);
assert.ok(headings.includes("Network Snapshot"), "plain table section label becomes a heading");
assert.ok(headings.includes("Active Projects"), "second plain table section label becomes a heading");
assert.ok(blocks.some((block) => block.type === "rule"), "horizontal rule is preserved");

const tables = blocks.filter((block) => block.type === "table");
assert.equal(tables.length, 2, "collapsed markdown tables render as table blocks");
assert.deepEqual(tables[0].header, ["Metric", "Value"]);
assert.deepEqual(tables[0].rows[0], ["Active projects", "5"]);
assert.deepEqual(tables[0].rows[2], ["Tasks in flight", "35"]);
assert.deepEqual(tables[1].header, ["Project", "Type", "Priority", "Tasks"]);
assert.deepEqual(tables[1].rows[0], ["Task Node Core Product", "Protocol Applications", "10", "323"]);

const normalTable = parseMarkdownBlocks("| A | B |\n|---|---|\n| one | two |");
assert.equal(normalTable.length, 1);
assert.equal(normalTable[0].type, "table");
assert.deepEqual(normalTable[0].rows[0], ["one", "two"]);

const prose = parseMarkdownBlocks("This is not a | table | because it has no delimiter row.");
assert.equal(prose.length, 1);
assert.equal(prose[0].type, "paragraph");

console.log("hive-report-markdown-smoke ok");
