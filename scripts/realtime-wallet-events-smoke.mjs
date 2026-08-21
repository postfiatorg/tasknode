import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  onceLocalRealtimeEvent,
  publishWalletActivityEvent,
  realtimeSubscriberCount,
  subscribeRealtimeEvents,
} from "../server/app-realtime.js";

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = null;
    this.statusCode = null;
    this.chunks = [];
    this.destroyed = false;
    this.writableEnded = false;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  end(chunk = "") {
    if (chunk) this.write(chunk);
    this.writableEnded = true;
    this.emit("close");
  }
}

const req = new EventEmitter();
const res = new MockResponse();
const accountId = "acct_realtime_smoke";
const walletAddress = "rRealtimeSmokeWallet";
const txHash = "ABCDEF1234567890";

const subscribed = subscribeRealtimeEvents({
  req,
  res,
  session: { accountId },
  linkedWallet: { address: walletAddress },
});

assert.equal(subscribed.ok, true);
assert.equal(res.statusCode, 200);
assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
assert.equal(realtimeSubscriberCount(accountId), 1);
assert.match(res.chunks.join(""), /event: connected/);

const localEvent = onceLocalRealtimeEvent();
const published = await publishWalletActivityEvent({
  accountId,
  walletAddress,
  txHash,
  ledgerIndex: 123,
  source: "smoke",
}, { notify: false });
const emitted = await localEvent;

assert.equal(published.ok, true);
assert.equal(published.delivered, 1);
assert.equal(emitted.type, "wallet_activity");

const stream = res.chunks.join("");
assert.match(stream, /event: wallet_activity/);
assert.match(stream, new RegExp(walletAddress));
assert.match(stream, new RegExp(txHash));

req.emit("close");
assert.equal(realtimeSubscriberCount(accountId), 0);

console.log("realtime wallet events smoke ok");
