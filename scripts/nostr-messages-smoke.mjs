import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateTaskNodeMnemonic } from "../src/wallet-core.js";
import {
  buildNostrDerivationMessage,
  createDirectMessageCatchUp,
  createDirectMessageEvents,
  deriveNostrMessagingIdentity,
  directMessageCatchUpSince,
  normalizeMessageRelays,
  subscribeDirectMessages,
  unwrapDirectMessage,
} from "../src/features/messages/nostr-messages.js";
import { conversationThreads, mergeMessageContact, mergeMessages } from "../src/features/messages/messages-state.js";
import {
  buildNostrWellKnownDirectory,
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
assert.equal(directMessageCatchUpSince(172800000), -300, "catch-up must cover NIP-17's two-day timestamp privacy window plus clock skew");

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

let livePoolOptions = null;
let liveSubscription = null;
let liveSubscriptionClosed = false;
let livePoolDestroyed = false;
const liveMessages = [];
const liveStatuses = [];
const liveInbox = subscribeDirectMessages({
  privateKey: bob.privateKey,
  relays: ["wss://nos.lol"],
  since: 1234,
  onMessage: (message) => liveMessages.push(message),
  onStatus: ({ status }) => liveStatuses.push(status),
  poolFactory(options) {
    livePoolOptions = options;
    return {
      subscribeMany(relays, filter, callbacks) {
        liveSubscription = { relays, filter, callbacks };
        return { close() { liveSubscriptionClosed = true; } };
      },
      destroy() { livePoolDestroyed = true; },
    };
  },
});
assert.deepEqual(livePoolOptions, { enableReconnect: true }, "live inbox should reconnect relay sockets automatically");
assert.deepEqual(liveSubscription.relays, ["wss://nos.lol"]);
assert.deepEqual(liveSubscription.filter, { kinds: [1059], "#p": [bob.publicKeyHex], since: 1234 });
assert.equal(liveSubscription.callbacks.maxWait, 9000);
liveSubscription.callbacks.oneose();
liveSubscription.callbacks.onevent(wrapped.recipientCopy);
assert.equal(liveMessages.length, 1, "the recipient wallet should receive a published gift wrap without manual sync");
assert.equal(liveMessages[0].content, "Private hello");
assert.deepEqual(liveStatuses, ["connecting", "live"]);
liveSubscription.callbacks.onevent(tampered);
assert.equal(liveMessages.length, 1, "a malformed live event should be ignored without stopping delivery");
liveInbox.close();
assert.equal(liveSubscriptionClosed, true);
assert.equal(livePoolDestroyed, true);

const catchUpTimers = new Map();
const clearedCatchUpTimers = [];
let catchUpTimerId = 0;
let releaseCatchUp;
let catchUpCalls = 0;
const catchUp = createDirectMessageCatchUp({
  intervalMs: 1000,
  sync() {
    catchUpCalls += 1;
    return new Promise((resolve) => { releaseCatchUp = resolve; });
  },
  setTimer(callback, delay) {
    catchUpTimerId += 1;
    catchUpTimers.set(catchUpTimerId, { callback, delay });
    return catchUpTimerId;
  },
  clearTimer(timerId) {
    clearedCatchUpTimers.push(timerId);
    catchUpTimers.delete(timerId);
  },
});
assert.equal(catchUpTimers.get(1)?.delay, 1000, "the inbox should schedule automatic relay catch-up");
assert.equal(catchUp.runNow(), true, "visibility and online recovery should trigger catch-up immediately");
assert.deepEqual(clearedCatchUpTimers, [1]);
await Promise.resolve();
assert.equal(catchUpCalls, 1);
assert.equal(catchUp.runNow(), false, "catch-up passes must not overlap while a relay query is running");
releaseCatchUp();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(catchUpTimers.size, 1, "a completed pass should schedule the next automatic catch-up");
catchUp.close();
assert.equal(catchUpTimers.size, 0, "closing Messages should stop automatic catch-up");

assert.throws(() => unwrapDirectMessage(tampered, bob.privateKey), /Invalid gift wrap/);
assert.throws(() => unwrapDirectMessage(wrapped.recipientCopy, alice.privateKey), /another recipient/);

assert.deepEqual(normalizeMessageRelays(["wss://nos.lol/", "wss://nos.lol", "https://not-a-relay.test"]), ["wss://nos.lol"]);
assert.deepEqual(normalizeNostrRelays(["wss://relay.primal.net/", "wss://relay.primal.net", "ws://insecure.test"]), ["wss://relay.primal.net"]);
assert.equal(taskNodeNostrName("@Good_Alexander"), "good_alexander");
assert.equal(taskNodeNostrName("bad handle"), "");
assert.equal(taskNodeNostrDomain("https://TASKNODE.POSTFIAT.ORG/"), "tasknode.postfiat.org");
assert.equal(taskNodeNostrAddress("goodalexander", "tasknode.postfiat.org"), "goodalexander@tasknode.postfiat.org");
const directoryPubkey = "a".repeat(64);
assert.deepEqual(
  buildNostrWellKnownDirectory({
    discoverable: [{ accountId: "account_bob", hiveHandle: "Bob", publicDisplayName: "Bob Builder" }],
    rows: [{
      account_id: "account_bob",
      nostr_pubkey_hex: directoryPubkey,
      preferred_relays: ["wss://nos.lol"],
      hero_nft_image_cid: "selected-profile-cid",
      hero_nft_image_gateway_url: "https://images.example/selected-profile-cid",
    }],
  }),
  {
    names: { bob: directoryPubkey },
    relays: { [directoryPubkey]: ["wss://nos.lol"] },
    profiles: {
      [directoryPubkey]: {
        displayName: "Bob Builder",
        hiveHandle: "bob",
        heroNft: {
          imageCid: "selected-profile-cid",
          imageGatewayUrl: "https://images.example/selected-profile-cid",
        },
      },
    },
  },
  "the public Nostr address book should carry each member's canonical profile PFP"
);

const merged = mergeMessages([senderMessage], [senderMessage, { ...senderMessage, id: "next", createdAtUnix: senderMessage.createdAtUnix + 1 }]);
assert.equal(merged.length, 2);
assert.equal(conversationThreads(merged, { [bob.publicKeyHex]: { hiveHandle: "bob" } })[0].contact.hiveHandle, "bob");
assert.deepEqual(
  mergeMessageContact(
    { displayName: "@bob", preferredRelays: ["wss://nos.lol"], heroNft: { imageCid: "old" } },
    { displayName: "Bob", heroNft: { imageCid: "selected-profile-cid" } }
  ),
  {
    displayName: "Bob",
    preferredRelays: ["wss://nos.lol"],
    heroNft: { imageCid: "selected-profile-cid" },
  },
  "directory hydration should refresh a cached contact's PFP without losing delivery metadata"
);
assert.equal(
  mergeMessageContact({ heroNft: { imageCid: "stale-profile-cid" } }, { heroNft: null }).heroNft,
  null,
  "directory hydration should clear a stale PFP when the profile no longer has a usable public image"
);

for (const path of ["/api/messages/bootstrap", "/api/messages/identity", "/api/messages/resolve"]) {
  assert.equal(routePolicyForPath(path)?.auth, "session", `${path} must require a signed-in session`);
}

const routes = await readFile(new URL("../server/collaboration-routes.js", import.meta.url), "utf8");
assert.match(routes, /\/\.well-known\/nostr\.json/);
assert.match(routes, /TASKNODE_MESSAGES_ENABLED/);
const shell = await readFile(new URL("../src/main.jsx", import.meta.url), "utf8");
assert.match(shell, /label="Messages"/);
assert.match(shell, /navigateToView\("messages"\)/);
assert.match(shell, /<ComposerSendButton/, "chat should use the shared composer send control");
const messagesView = await readFile(new URL("../src/features/messages/MessagesView.jsx", import.meta.url), "utf8");
assert.match(messagesView, /createDirectMessageCatchUp/, "Messages should recover missed relay events without a refresh");
assert.match(messagesView, /<ComposerSendButton ariaLabel="Send message"/, "Messages should use the shared composer send control");
assert.match(messagesView, /<MessagesAvatar contact=\{author\}/, "each message row should identify its author with the profile avatar");
assert.match(messagesView, /profileNftImageCandidates/, "Messages avatars should use the shared profile PFP image resolver");

console.log("nostr messages smoke passed");
