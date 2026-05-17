#!/usr/bin/env node
import assert from "node:assert/strict";

import { markdownToBlocks, plainTextFromBlocks } from "../src/features/chat/chat-markdown.js";

const compactTable =
  "| Aspect | Bitcoin | Ethereum | |-----------------------|-----------------------|-----------------------| | Purpose | Store of value | Smart contracts |";
const tableBlocks = markdownToBlocks(compactTable);
assert.equal(tableBlocks[0]?.type, "table");
assert.deepEqual(
  tableBlocks[0].headers.map((inline) => inline[0]?.text),
  ["Aspect", "Bitcoin", "Ethereum"],
);
assert.equal(tableBlocks[0].rows[0][0][0].text, "Purpose");

const blocks = markdownToBlocks("## Header\n\n- **Fast**\n- `Safe`\n\nplain text");
assert.equal(blocks[0].type, "h2");
assert.equal(blocks[1].type, "ul");
assert.equal(plainTextFromBlocks(blocks), "Header\n\nFast\nSafe\n\nplain text");

console.log("chat markdown smoke ok");
