import assert from "node:assert/strict";
import test from "node:test";
import { transactionExplorerHref, walletExplorerHref } from "../src/pftl-explorer.js";

const BASE = "https://explorer.testnet.postfiat.org";
const ADDRESS = "rPExxzu9ULk8yuGDkfAJb4xYgPSgSesnSk";

test("wallet links use the explorer's /accounts/:id route", () => {
  // Profile wallet links previously built `<base>/<address>`, which the
  // explorer's router does not match (its account route is /accounts/:id),
  // so every profile wallet link opened the explorer's not-found page.
  assert.equal(walletExplorerHref(ADDRESS, BASE), `${BASE}/accounts/${ADDRESS}`);
  assert.equal(walletExplorerHref(ADDRESS, `${BASE}///`), `${BASE}/accounts/${ADDRESS}`);
  assert.equal(walletExplorerHref(`  ${ADDRESS}  `, ` ${BASE} `), `${BASE}/accounts/${ADDRESS}`);
});

test("wallet links honour an explicit address placeholder", () => {
  assert.equal(
    walletExplorerHref(ADDRESS, "https://other.example/a/{address}/overview"),
    `https://other.example/a/${ADDRESS}/overview`,
  );
  assert.equal(walletExplorerHref(ADDRESS, "https://other.example/{account}"), `https://other.example/${ADDRESS}`);
});

test("wallet links encode the address and stay empty without inputs", () => {
  assert.equal(walletExplorerHref("r/weird address", BASE), `${BASE}/accounts/r%2Fweird%20address`);
  assert.equal(walletExplorerHref("", BASE), "");
  assert.equal(walletExplorerHref(ADDRESS, ""), "");
  assert.equal(walletExplorerHref(undefined, undefined), "");
});

test("transaction links are unchanged and share the base handling", () => {
  assert.equal(transactionExplorerHref("ABC123", BASE), `${BASE}/transactions/ABC123`);
  assert.equal(transactionExplorerHref("ABC123", `${BASE}/`), `${BASE}/transactions/ABC123`);
  assert.equal(transactionExplorerHref("", BASE), "");
});
