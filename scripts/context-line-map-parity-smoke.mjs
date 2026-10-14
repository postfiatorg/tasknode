import assert from "node:assert/strict";
import { contextDocumentPacket } from "../server/context-line-map.js";
import { contextBodyText, contextLineCount } from "../shared/context-line-map.js";
import { normalizeContextBodyForStorage } from "../shared/context-html.js";
import { htmlFragment, htmlTreeText } from "../shared/html-tree.js";

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

// Preserve the readable cell boundaries and the existing non-block projection.
const tableCases = [
  ["bare-text", "<table><tr><td>Ship A</td><td>Reject B</td></tr></table>", "Ship A\nReject B", "Ship AReject B"],
  ["bare-numbers", "<table><tr><td>10</td><td>20</td></tr></table>", "10\n20", "1020"],
  ["header-cells", "<table><tr><th>Asset</th><th>Debt</th></tr></table>", "Asset\nDebt", "AssetDebt"],
  ["mixed-header-data", "<table><tr><th>Limit</th><td>20</td></tr></table>", "Limit\n20", "Limit20"],
  ["multiple-rows", "<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>", "A\nB\n\nC\nD", "ABCD"],
  ["empty-cells", "<table><tr><td></td><td>A</td><td></td><td>B</td></tr></table>", "A\nB", "AB"],
  ["inline-formatting", "<table><tr><td>Ship <b>A</b></td><td><i>Reject B</i></td></tr></table>", "Ship A\nReject B", "Ship AReject B"],
  ["same-cell-inline-join", "<table><tr><td><b>A</b><i>B</i></td><td>C</td></tr></table>", "AB\nC", "ABC"],
  ["paragraph-wrapped-control", "<table><tr><td><p>A</p></td><td><p>B</p></td></tr></table>", "A\nB", "AB"],
  ["paragraph-trailing-whitespace-control", "<table><tr><td><p>A</p> \t</td><td><p>B</p></td></tr></table>", "A\n \tB", "A \tB"],
  ["paragraph-then-inline", "<table><tr><td><p>A</p><b>B</b></td><td>C</td></tr></table>", "A\nB\nC", "ABC"],
  ["br-ending-control", "<table><tr><td>A<br></td><td>B</td></tr></table>", "A\nB", "A\nB"],
  ["newline-ending-control", "<table><tr><td>A\n</td><td>B</td></tr></table>", "A\nB", "A\nB"],
  ["list-ending-control", "<table><tr><td><ul><li>A</li><li>B</li></ul></td><td>C</td></tr></table>", "- A\n- B\n\nC", "ABC"],
  ["hidden-content", "<table><tr><td><script>hidden</script>A</td><td>B</td></tr></table>", "A\nB", "AB"],
  ["entities", "<table><tr><td>&amp;</td><td>&lt;</td></tr></table>", "&\n<", "&<"],
  ["astral-text", "<table><tr><td>😀</td><td>🐍</td></tr></table>", "😀\n🐍", "😀🐍"],
  ["empty-table", "<table><tr><td></td><td></td></tr></table>", "", ""],
  ["nested-table", "<table><tr><td><table><tr><td>10</td><td>20</td></tr></table></td><td>30</td></tr></table>", "10\n20\n\n30", "102030"],
  ["empty-formatted-cell", "<table><tr><td><p><br></p></td><td>B</td></tr></table>", "B", "\nB"],
  ["trailing-inline-space", "<table><tr><td>A </td><td>B</td></tr></table>", "A\nB", "A B"],
  ["outside-table-control", "<h1>Title</h1><p>Keep</p><ul><li>A</li><li>B</li></ul>", "Title\nKeep\n- A\n- B", "TitleKeepAB"],
  ["plain-text-control", "  Ship A / Reject B  ", "Ship A / Reject B", "  Ship A / Reject B  "],
  ["plain-newlines-control", "10\n20", "10\n20", "10\n20"],
];
for (const [name, input, expectedText, expectedInline] of tableCases) {
  assert.deepEqual({
    bodyText: contextBodyText(input),
    lineCount: contextLineCount(input),
    storedBodyText: contextBodyText(normalizeContextBodyForStorage(input)),
    nonBlockText: htmlTreeText(htmlFragment(input)),
  }, {
    bodyText: expectedText,
    lineCount: Math.max(1, expectedText ? expectedText.split("\n").length : 1),
    storedBodyText: expectedText,
    nonBlockText: expectedInline,
  }, name);
}

console.log("context line map parity smoke ok");
