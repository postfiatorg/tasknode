import assert from "node:assert/strict";
import { contextDocumentPacket } from "../server/context-line-map.js";
import { contextBodyText, contextLineCount } from "../shared/context-line-map.js";
import { normalizeContextBodyForStorage } from "../shared/context-html.js";
import { htmlFragment, htmlTreeText } from "../shared/html-tree.js";
import { stripHtmlToText } from "../server/task-review-evidence.js";

const htmlFixture = [
  "<h1>Focus</h1>",
  "<ul><li>First item</li><li>Second &amp; third</li></ul>",
  "<p>Trailing note</p>",
].join("");

const bodyText = contextBodyText(htmlFixture);
assert.match(bodyText, /^Focus/);
assert.match(bodyText, /- First item/);
assert.match(bodyText, /Second & third/);
assert.equal(contextLineCount(htmlFixture), bodyText.split("\n").length);

const packet = contextDocumentPacket({ body: htmlFixture, title: "Parity", revision: 3 });
assert.equal(packet.bodyText, bodyText);
assert.equal(packet.lineNumberedText.split("\n").length, contextLineCount(htmlFixture));

// Table cells keep their boundaries in block mode: one cell per line and a
// blank line between rows. A cell whose paragraph child already ended the line
// gets no extra break, so paragraph-wrapped tables read as before.
const prettyTable = "<table>\n  <tr>\n    <td>a</td>\n    <td>b</td>\n  </tr>\n  <tr>\n    <td>c</td>\n    <td>d</td>\n  </tr>\n</table>";
const tableCases = [
  ["<table><tr><td>Ship A</td><td>Reject B</td></tr></table>", "Ship A\nReject B"],
  ["<table><tr><td>10</td><td>20</td></tr></table>", "10\n20"],
  ["<table><tr><th>Option</th><th>Score</th></tr><tr><td>A</td><td>10</td></tr></table>", "Option\nScore\n\nA\n10"],
  ["<table><thead><tr><th>Option</th></tr></thead><tbody><tr><th>A</th><td>10</td><td>Ship</td></tr></tbody></table>", "Option\n\nA\n10\nShip"],
  ["<table><tbody><tr><td><p><strong>Goal 0</strong></p></td><td><p>Ship v0</p></td></tr></tbody></table>", "Goal 0\nShip v0"],
  ["<table><tr><td><p>Goal</p></td><td>bare</td><td><p>Ship</p></td></tr><tr><td><p>next</p></td></tr></table>", "Goal\nbare\nShip\n\nnext"],
  ["<table><tr><td><p>a</p></td><td><p></p></td><td><p>b</p></td></tr></table>", "a\n\nb"],
  ["<table><tr><td>a</td><td></td><td> </td><td>b</td></tr></table>", "a\nb"],
  ["<table><tr><td>  Ship   A  </td><td>\n  Reject B\n</td></tr></table>", "Ship   A\nReject B"],
  [prettyTable, "a\nb\n\nc\nd"],
  ["<table><tr><td>outer<table><tr><td>in1</td><td>in2</td></tr></table>tail</td><td>next</td></tr></table>", "outer\nin1\nin2\n\ntail\nnext"],
  ["<table><caption>Plan</caption><tr><td>a</td><td>b</td></tr></table>", "Plan\na\nb"],
  ["<table><tr><td>a<br>b</td><td>c</td></tr></table>", "a\nb\nc"],
  ["<table><tr><td><strong>Bold</strong> text</td><td>x</td></tr></table>", "Bold text\nx"],
  ["<p>Intro</p><table><tr><td>x</td><td>y</td></tr></table><p>Outro</p>", "Intro\nx\ny\n\nOutro"],
];
for (const [html, text] of tableCases) {
  assert.equal(contextBodyText(html), text, html);
  assert.equal(contextBodyText(normalizeContextBodyForStorage(html)), text, html);
  assert.equal(contextLineCount(html), text.split("\n").length, html);
}
// Non-block projection (titles, entity decoding) is unchanged.
assert.equal(htmlTreeText(htmlFragment("<table><tr><td>Ship A</td><td>Reject B</td></tr></table>")), "Ship AReject B");
assert.equal(htmlTreeText(htmlFragment(prettyTable)), "\n  \n    a\n    b\n  \n  \n    c\n    d\n  \n");
// Evidence page excerpts use the same block projection and keep cells apart.
assert.equal(stripHtmlToText("<table><tr><td>10</td><td>20</td></tr></table>"), "10 20");

console.log("context line map parity smoke ok");
