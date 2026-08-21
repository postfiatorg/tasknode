import assert from "node:assert/strict";
import { contextDocumentPacket } from "../server/context-line-map.js";
import { contextBodyText, contextLineCount } from "../shared/context-line-map.js";

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

console.log("context line map parity smoke ok");
