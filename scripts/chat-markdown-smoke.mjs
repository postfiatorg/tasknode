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

const implicitListBlocks = markdownToBlocks(
  [
    "Learn taste outside technology.",
    "Study:",
    "Typography",
    "Film editing",
    "Architecture",
    "Great interviews",
    "Leica cameras",
    "The original iPhone onboarding",
    "Retail environments",
    "Menu design",
    "Rhythm in music",
    "Why certain rooms feel calm",
    "",
    "Because the future winners in AI will not be the people who can generate the most output.",
  ].join("\n")
);
assert.equal(implicitListBlocks[0].type, "p");
assert.equal(implicitListBlocks[1].type, "p");
assert.equal(implicitListBlocks[2].type, "ul");
assert.equal(implicitListBlocks[2].items.length, 10);
assert.equal(plainTextFromBlocks(implicitListBlocks).includes("Study:\n\nTypography\nFilm editing"), true);

const shortExplanation = markdownToBlocks("Root cause:\nThe parser was too narrow.\nIt only handled explicit bullets.");
assert.equal(shortExplanation.length, 1);
assert.equal(shortExplanation[0].type, "p");

const looseOrderedList = markdownToBlocks("1. first\n\n1. second\n\n1. third");
assert.equal(looseOrderedList.length, 1);
assert.equal(looseOrderedList[0].type, "ol");
assert.equal(looseOrderedList[0].items.length, 3);
assert.equal(plainTextFromBlocks(looseOrderedList), "first\nsecond\nthird");

const compactOrderedList = markdownToBlocks("1. first 1. second 1. third");
assert.equal(compactOrderedList.length, 1);
assert.equal(compactOrderedList[0].type, "ol");
assert.equal(compactOrderedList[0].items.length, 3);
assert.equal(plainTextFromBlocks(compactOrderedList), "first\nsecond\nthird");

const sectionedOrderedList = markdownToBlocks(
  [
    "1. Make the task loop feel unbreakably clear.",
    "",
    "Not feature rich. Clear.",
    "",
    "2. Finish the wallet unlock gate.",
    "",
    "Locked. Unlock pending. Unlocked.",
    "",
    "3. Redesign the modal flows until they feel inevitable.",
  ].join("\n")
);
const sectionedOrderedStarts = sectionedOrderedList
  .filter((block) => block.type === "ol")
  .map((block) => block.start || 1);
assert.deepEqual(sectionedOrderedStarts, [1, 2, 3]);

console.log("chat markdown smoke ok");
