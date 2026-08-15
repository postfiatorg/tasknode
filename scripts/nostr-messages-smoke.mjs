import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateTaskNodeMnemonic } from "../src/wallet-core.js";
import {
  buildNostrDerivationMessage,
  createDirectMessageEvents,
  deriveNostrMessagingIdentity,
  normalizeMessageRelays,
  unwrapDirectMessage,
} from "../src/features/messages/nostr-messages.js";
import { conversationThreads, mergeMessages } from "../src/features/messages/messages-state.js";
import {
  normalizeNostrRelays,
  taskNodeNostrAddress,
  taskNodeNostrDomain,
  taskNodeNostrName,
} from "../server/repositories/nostr-messages.js";
import { routePolicyForPath } from "../server/route-policies.js";

const mnemonic = generateTaskNodeMnemonic();
const alice = await deriveNostrMessagingIdentity({ accountId: "account_alice", walletSecret: { mnemonic } });
const aliceAgain = await deriveNostrMessagingIdentity({ accountId: "account_alice", walletSecret: { mnemonic } });
const otherAccount = await deriveNostrMessagingIdentity({ accountId: "account_other", walletSecret: { mnemonic } });
const bob = await deriveNostrMessagingIdentity({ accountId: "account_bob", walletSecret: { mnemonic: generateTaskNodeMnemonic() } });

assert.equal(alice.publicKeyHex, aliceAgain.publicKeyHex, "wallet derivation must be stable");
assert.notEqual(alice.publicKeyHex, otherAccount.publicKeyHex, "identity must be account scoped");
assert.match(buildNostrDerivationMessage({ accountId: "account_alice", walletAddress: alice.walletAddress }), /not a transaction/);

const wrapped = createDirectMessageEvents({
  privateKey: alice.privateKey,
  recipientPublicKey: bob.publicKeyHex,
  recipientRelay: "wss://nos.lol",
  message: "Private hello",
});
const senderMessage = unwrapDirectMessage(wrapped.senderCopy, alice.privateKey);
const recipientMessage = unwrapDirectMessage(wrapped.recipientCopy, bob.privateKey);
assert.equal(senderMessage.content, "Private hello");
assert.equal(senderMessage.mine, true);
assert.equal(senderMessage.peerPublicKey, bob.publicKeyHex);
assert.equal(recipientMessage.content, "Private hello");
assert.equal(recipientMessage.mine, false);
assert.equal(recipientMessage.peerPublicKey, alice.publicKeyHex);
assert.notEqual(recipientMessage.wrapId, senderMessage.wrapId, "sender and recipient must receive separate gift wraps");

const tampered = { ...wrapped.recipientCopy, content: `${wrapped.recipientCopy.content.slice(0, -2)}aa` };
assert.throws(() => unwrapDirectMessage(tampered, bob.privateKey), /Invalid gift wrap/);
assert.throws(() => unwrapDirectMessage(wrapped.recipientCopy, alice.privateKey), /another recipient/);

assert.deepEqual(normalizeMessageRelays(["wss://nos.lol/", "wss://nos.lol", "https://not-a-relay.test"]), ["wss://nos.lol"]);
assert.deepEqual(normalizeNostrRelays(["wss://relay.primal.net/", "wss://relay.primal.net", "ws://insecure.test"]), ["wss://relay.primal.net"]);
assert.equal(taskNodeNostrName("@Good_Alexander"), "good_alexander");
assert.equal(taskNodeNostrName("bad handle"), "");
assert.equal(taskNodeNostrDomain("https://TASKNODE.POSTFIAT.ORG/"), "tasknode.postfiat.org");
assert.equal(taskNodeNostrAddress("goodalexander", "tasknode.postfiat.org"), "goodalexander@tasknode.postfiat.org");

const merged = mergeMessages([senderMessage], [senderMessage, { ...senderMessage, id: "next", createdAtUnix: senderMessage.createdAtUnix + 1 }]);
assert.equal(merged.length, 2);
assert.equal(conversationThreads(merged, { [bob.publicKeyHex]: { hiveHandle: "bob" } })[0].contact.hiveHandle, "bob");

for (const path of ["/api/messages/bootstrap", "/api/messages/identity", "/api/messages/resolve"]) {
  assert.equal(routePolicyForPath(path)?.auth, "session", `${path} must require a signed-in session`);
}

const routes = await readFile(new URL("../server/collaboration-routes.js", import.meta.url), "utf8");
assert.match(routes, /\/\.well-known\/nostr\.json/);
assert.match(routes, /TASKNODE_MESSAGES_ENABLED/);
const shell = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");
assert.match(shell, /label="Messages"/);
assert.match(shell, /navigateToView\("messages"\)/);

console.log("nostr messages smoke passed");
