import assert from "node:assert/strict";
import { normalizeWalletTransactions } from "../server/pftl-transactions.js";

const walletAddress = "rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx";
const incomingCounterparty = "rKt4peDoQ4YMq7AHvRtQnMZR3LAeAf6pQE";
const outgoingCounterparty = "rwdm72S9Ahpc5qsdVopX3xs7xQkpPnSfH7";

const rows = normalizeWalletTransactions(
  [
    {
      tx_json: {
        TransactionType: "Payment",
        Account: incomingCounterparty,
        Destination: walletAddress,
        Amount: "47200000000",
        Fee: "12",
        date: 831600000,
        hash: "INHASH",
      },
      meta: { TransactionResult: "tesSUCCESS" },
      ledger_index: 101,
    },
    {
      tx_json: {
        TransactionType: "OfferCreate",
        Account: walletAddress,
        date: 831599100,
        hash: "IGNORED",
      },
      ledger_index: 100,
    },
    {
      tx_json: {
        TransactionType: "Payment",
        Account: incomingCounterparty,
        Destination: walletAddress,
        Amount: "99000000000",
        Fee: "12",
        date: 831599500,
        hash: "FAILEDHASH",
      },
      meta: { TransactionResult: "tecPATH_DRY" },
      ledger_index: 100,
    },
    {
      tx_json: {
        TransactionType: "Payment",
        Account: walletAddress,
        Destination: outgoingCounterparty,
        Amount: "3840000000",
        Fee: "12",
        date: 831599000,
        hash: "OUTHASH",
      },
      meta: { TransactionResult: "tesSUCCESS" },
      ledger_index: 98,
    },
  ],
  walletAddress,
  { limit: 10 }
);

assert.equal(rows.length, 2);
assert.equal(rows[0].type, "in");
assert.equal(rows[0].label, "Received PFT");
assert.equal(rows[0].amountDrops, "47200000000");
assert.equal(rows[0].signedDrops, "47200000000");
assert.equal(rows[0].amountPft, "47,200");
assert.equal(rows[0].counterparty, incomingCounterparty);
assert.equal(rows[1].type, "out");
assert.equal(rows[1].label, "Sent PFT");
assert.equal(rows[1].amountDrops, "3840000000");
assert.equal(rows[1].signedDrops, "-3840000000");
assert.equal(rows[1].amountPft, "3,840");
assert.equal(rows[1].counterparty, outgoingCounterparty);

console.log("wallet transaction normalization smoke ok");
