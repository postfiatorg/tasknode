import assert from "node:assert/strict";
import {
  decodePftPointerMemo,
  extractPftPointerEvents,
  fetchHistoricalAccountTransactions,
  historyRpcConfig,
} from "../server/context-history-rpc.js";
import { buildPftPointerMemo } from "../server/pftl-pointer.js";

const textEncoder = new TextEncoder();
const walletAddress = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function utf8Hex(value) {
  return bytesToHex(textEncoder.encode(String(value)));
}

function varintBytes(value) {
  let number = Number(value);
  const bytes = [];
  while (number > 0x7f) {
    bytes.push((number & 0x7f) | 0x80);
    number >>>= 7;
  }
  bytes.push(number);
  return bytes;
}

function fieldVarint(fieldNumber, value) {
  return [...varintBytes(fieldNumber << 3), ...varintBytes(value)];
}

function fieldString(fieldNumber, value) {
  const bytes = Array.from(textEncoder.encode(String(value)));
  return [...varintBytes((fieldNumber << 3) | 2), ...varintBytes(bytes.length), ...bytes];
}

function pointerMemoHex({
  cid = "bafycontextcid",
  kind = 5,
  schema = 1,
  contextId = "context-smoke",
} = {}) {
  return bytesToHex([
    ...fieldString(1, cid),
    ...fieldVarint(2, 1),
    ...fieldVarint(3, kind),
    ...fieldVarint(4, schema),
    ...fieldString(7, contextId),
    ...fieldVarint(8, 1),
  ]);
}

function pointerMemo(kind, cid) {
  return {
    Memo: {
      MemoType: utf8Hex("pf.ptr"),
      MemoFormat: utf8Hex("v4"),
      MemoData: pointerMemoHex({ kind, cid }),
    },
  };
}

const contextPointer = decodePftPointerMemo(pointerMemoHex({
  cid: "ipfs://bafycontextcid?ignored=true",
  kind: 5,
  schema: 4,
  contextId: "ctx-1",
}));
assert.equal(contextPointer.cid, "bafycontextcid");
assert.equal(contextPointer.kind, 5);
assert.equal(contextPointer.kindLabel, "CONTEXT");
assert.equal(contextPointer.schema, 4);
assert.equal(contextPointer.contextId, "ctx-1");

const builtPointer = buildPftPointerMemo({
  cid: "bafycontextbuilt",
  kind: "CONTEXT",
  schema: 1,
  flags: 1,
  contextId: "ctx-built",
});
const decodedBuiltPointer = decodePftPointerMemo(builtPointer.memoDataHex);
assert.equal(Buffer.from(builtPointer.memoTypeHex, "hex").toString("utf8"), "pf.ptr");
assert.equal(Buffer.from(builtPointer.memoFormatHex, "hex").toString("utf8"), "v4");
assert.equal(decodedBuiltPointer.cid, "bafycontextbuilt");
assert.equal(decodedBuiltPointer.kind, 5);
assert.equal(decodedBuiltPointer.contextId, "ctx-built");

const transactions = [
  {
    tx_json: {
      Account: walletAddress,
      Destination: "rDestination1111111111111111111111111",
      hash: "CTX_TX",
      ledger_index: 100,
      date: 829267200,
      Memos: [
        pointerMemo(5, "bafycontextcid"),
        pointerMemo(4, "bafychatcid"),
        {
          Memo: {
            MemoType: utf8Hex("other"),
            MemoFormat: utf8Hex("v4"),
            MemoData: pointerMemoHex({ kind: 5, cid: "bafyignored" }),
          },
        },
      ],
    },
  },
];

const pointerEvents = extractPftPointerEvents(transactions, walletAddress);
assert.equal(pointerEvents.length, 2);
assert.equal(pointerEvents[0].direction, "outbound");
assert.equal(pointerEvents[0].createdAt, "2026-04-12T00:00:00.000Z");

const contextEvents = extractPftPointerEvents(transactions, walletAddress)
  .filter((event) => event.kindLabel === "CONTEXT");
assert.equal(contextEvents.length, 1);
assert.equal(contextEvents[0].cid, "bafycontextcid");

let requestCount = 0;
const fakeFetch = async (url, options) => {
  requestCount += 1;
  const body = JSON.parse(options.body);
  assert.equal(url, "https://archive.example/rpc");
  assert.equal(body.method, "account_tx");
  assert.equal(body.params[0].account, walletAddress);
  assert.equal(options.headers["X-Api-Key"], "history-secret");

  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: body.id,
    result: {
      transactions,
      marker: null,
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const accountTx = await fetchHistoricalAccountTransactions({
  walletAddress,
  env: {
    PFTL_HISTORY_WSS_URL: "",
    PFTL_HISTORY_RPC_URL: "https://archive.example/rpc",
    PFTL_HISTORY_RPC_API_KEY: "history-secret",
    PFTL_HISTORY_ACCOUNT_TX_MAX_PAGES: "1",
  },
  fetchImpl: fakeFetch,
});

assert.equal(requestCount, 1);
assert.equal(accountTx.transactions.length, 1);
assert.equal(accountTx.complete, true);
const fetchedContextEvents = extractPftPointerEvents(accountTx.transactions, walletAddress)
  .filter((event) => event.kindLabel === "CONTEXT");
assert.equal(fetchedContextEvents.length, 1);
assert.equal(fetchedContextEvents[0].cid, "bafycontextcid");

const defaultConfig = historyRpcConfig({});
assert.deepEqual(defaultConfig.wssUrls, ["wss://ws-archive.testnet.postfiat.org/"]);
assert.deepEqual(defaultConfig.rpcUrls, ["https://rpc.testnet.postfiat.org:5006/"]);
assert.equal(defaultConfig.defaultedWssPrimary, true);
assert.equal(defaultConfig.defaultedRpcPrimary, true);
assert.equal(defaultConfig.apiKey, "");

await assert.rejects(
  () => fetchHistoricalAccountTransactions({ walletAddress: "not-a-wallet", fetchImpl: fakeFetch }),
  /context_history_invalid_wallet/
);

await assert.rejects(
  () => fetchHistoricalAccountTransactions({
    walletAddress,
    env: { PFTL_HISTORY_WSS_URL: "", PFTL_HISTORY_RPC_URL: "https://archive.example/rpc" },
    fetchImpl: async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        status: "error",
        error: "actNotFound",
        error_message: "Account not found.",
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  }),
  /Account not found/
);

console.log("context history rpc smoke ok");
