#!/usr/bin/env node
import assert from "node:assert/strict";
import { Interface, parseUnits } from "ethers";

import {
  buildTopUpTransaction,
  creditedBaseUnits,
  encodeErc20Transfer,
  etherscanTxUrl,
  formatBaseUnits,
  isEvmAddress,
  mapWalletError,
  parseAmountToBaseUnits,
  selectMetaMaskProvider,
  sendTopUpPayment,
  shortHex,
  toHexQuantity,
  validateTopUpAmount,
  WALLET_ERROR_COPY,
} from "../src/features/billing/evm-wallet-pay.js";

const USDC = {
  symbol: "USDC",
  decimals: 6,
  kind: "erc20",
  contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};
const USDT = {
  symbol: "USDT",
  decimals: 6,
  kind: "erc20",
  contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
};
const ETH = { symbol: "ETH", decimals: 18, kind: "native", contractAddress: null };
const DEPOSIT = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const PAYER = "0x00000000000000000000000000000000000000aa";
const TX_HASH = `0x${"ab".repeat(32)}`;

// Decimal strings -> integer base units, no floating point.
assert.equal(parseAmountToBaseUnits("10", 6), 10_000_000n);
assert.equal(parseAmountToBaseUnits("0.000000000000000001", 18), 1n);
assert.equal(parseAmountToBaseUnits("25.5", 6), 25_500_000n);
assert.equal(parseAmountToBaseUnits(" 1. ", 6), 1_000_000n);
assert.equal(parseAmountToBaseUnits(".5", 6), 500_000n);
assert.equal(parseAmountToBaseUnits("0.1", 18), 100_000_000_000_000_000n);
assert.equal(parseAmountToBaseUnits("123456789.123456", 6), parseUnits("123456789.123456", 6));
assert.equal(parseAmountToBaseUnits("0.30000000000000004", 18), parseUnits("0.30000000000000004", 18));
assert.throws(() => parseAmountToBaseUnits("1.0000001", 6), /up to 6 decimal places/);
for (const bad of ["-1", "-0.5", "abc", "1e6", "1,000", "0x10", "1.2.3", ".", "", "  ", "+5", "Infinity", "NaN", "$10"]) {
  assert.throws(() => parseAmountToBaseUnits(bad, 6), { code: "TN_INVALID_AMOUNT" }, `should reject ${JSON.stringify(bad)}`);
}
assert.throws(() => parseAmountToBaseUnits("0", 6), /greater than zero/);
assert.throws(() => parseAmountToBaseUnits("0.000000", 6), /greater than zero/);

assert.equal(formatBaseUnits(10_000_000n, 6), "10");
assert.equal(formatBaseUnits(25_500_000n, 6), "25.5");
assert.equal(formatBaseUnits(1n, 18), "0.000000000000000001");
assert.equal(formatBaseUnits(0n, 6), "0");

// Form validation: per-asset decimals and a per-payment ceiling.
assert.deepEqual(validateTopUpAmount("25", USDC), { ok: true, baseUnits: 25_000_000n, error: "" });
assert.equal(validateTopUpAmount("10000", USDT).ok, true);
assert.match(validateTopUpAmount("10000.01", USDC).error, /up to \$10,000 per payment/);
assert.match(validateTopUpAmount("1.0000001", USDC).error, /USDC supports up to 6 decimal places/);
assert.equal(validateTopUpAmount("0.000000000000000001", ETH).ok, true);
assert.match(validateTopUpAmount("5.000000000000000001", ETH).error, /up to 5 ETH per payment/);
assert.equal(validateTopUpAmount("10", { ...USDC, contractAddress: "0x123" }).ok, false);
assert.equal(validateTopUpAmount("10", { symbol: "USDC", kind: "erc20", contractAddress: USDC.contractAddress }).ok, true);

// ERC-20 transfer(address,uint256) calldata, checked against a fixed vector
// and against ethers' ABI encoder.
const expectedCalldata =
  "0xa9059cbb" +
  "000000000000000000000000abcdef0123456789abcdef0123456789abcdef01" +
  "0000000000000000000000000000000000000000000000000000000000989680";
assert.equal(encodeErc20Transfer(DEPOSIT, 10_000_000n), expectedCalldata);
const erc20 = new Interface(["function transfer(address to, uint256 amount)"]);
assert.equal(encodeErc20Transfer(DEPOSIT, 10_000_000n), erc20.encodeFunctionData("transfer", [DEPOSIT.toLowerCase(), 10_000_000n]));
assert.equal(encodeErc20Transfer(DEPOSIT, (1n << 256n) - 1n), erc20.encodeFunctionData("transfer", [DEPOSIT.toLowerCase(), (1n << 256n) - 1n]));
assert.throws(() => encodeErc20Transfer("0x1234", 1n), /valid Ethereum address/);
assert.throws(() => encodeErc20Transfer(DEPOSIT, 0n), /out of range/);
assert.throws(() => encodeErc20Transfer(DEPOSIT, 1n << 256n), /out of range/);
assert.equal(isEvmAddress(DEPOSIT.toLowerCase()), true);
assert.equal(isEvmAddress(`0x${"g".repeat(40)}`), false);
assert.equal(toHexQuantity(0n), "0x0");
assert.equal(toHexQuantity(10n ** 16n), "0x2386f26fc10000");

assert.deepEqual(buildTopUpTransaction({ asset: USDC, from: PAYER, depositAddress: DEPOSIT, baseUnits: 10_000_000n }), {
  from: PAYER,
  to: USDC.contractAddress,
  value: "0x0",
  data: expectedCalldata,
  chainId: "0x1",
});
assert.deepEqual(buildTopUpTransaction({ asset: ETH, from: PAYER, depositAddress: DEPOSIT, baseUnits: 10n ** 16n }), {
  from: PAYER,
  to: DEPOSIT,
  value: "0x2386f26fc10000",
  chainId: "0x1",
});

// Provider selection prefers the real MetaMask and skips Phantom, which also
// sets isMetaMask.
const request = async () => null;
const phantom = { isMetaMask: true, isPhantom: true, request };
const metamask = { isMetaMask: true, request };
const coinbase = { isCoinbaseWallet: true, request };
assert.equal(selectMetaMaskProvider({ injected: { ...phantom, providers: [phantom, coinbase, metamask] } }), metamask);
assert.equal(selectMetaMaskProvider({ injected: phantom }), undefined);
assert.equal(selectMetaMaskProvider({ injected: metamask }), metamask);
assert.equal(selectMetaMaskProvider({ injected: undefined }), undefined);
const announcedMetaMask = { isMetaMask: true, request };
assert.equal(
  selectMetaMaskProvider({
    injected: phantom,
    announced: [
      { info: { rdns: "app.phantom" }, provider: phantom },
      { info: { rdns: "io.metamask" }, provider: announcedMetaMask },
    ],
  }),
  announcedMetaMask,
);

// Error copy.
assert.equal(mapWalletError({ code: 4001, message: "User rejected the request." }), WALLET_ERROR_COPY.rejected);
assert.equal(mapWalletError({ code: "ACTION_REJECTED" }), WALLET_ERROR_COPY.rejected);
assert.equal(mapWalletError({ code: -32603, data: { originalError: { code: 4001 } } }), WALLET_ERROR_COPY.rejected);
assert.equal(mapWalletError({ code: 4902, message: "Unrecognized chain ID" }), WALLET_ERROR_COPY.wrongNetwork);
assert.equal(mapWalletError({ code: -32002 }), WALLET_ERROR_COPY.pending);
assert.equal(
  mapWalletError({ code: -32000, message: "insufficient funds for gas * price + value" }, { assetSymbol: "USDC" }),
  WALLET_ERROR_COPY.gas,
);
assert.equal(
  mapWalletError({ code: -32603, error: { message: "insufficient funds for intrinsic transaction cost" } }, { assetSymbol: "ETH" }),
  WALLET_ERROR_COPY.ethBalance,
);
assert.equal(mapWalletError(new Error("socket hang up")), WALLET_ERROR_COPY.generic);

// Full flow against a fake provider: connect, switch from Base to mainnet, send.
function fakeProvider({ chainId = "0x2105", switchError = null, sendError = null } = {}) {
  const calls = [];
  let activeChain = chainId;
  return {
    calls,
    isMetaMask: true,
    async request({ method, params }) {
      calls.push({ method, params });
      if (method === "eth_requestAccounts") return [PAYER];
      if (method === "eth_chainId") return activeChain;
      if (method === "wallet_switchEthereumChain") {
        if (switchError) throw switchError;
        activeChain = params[0].chainId;
        return null;
      }
      if (method === "eth_sendTransaction") {
        if (sendError) throw sendError;
        return TX_HASH;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

const stages = [];
const provider = fakeProvider();
const sent = await sendTopUpPayment({
  provider,
  asset: USDT,
  depositAddress: DEPOSIT,
  baseUnits: 50_000_000n,
  onStage: (stage) => stages.push(stage),
});
assert.equal(sent.txHash, TX_HASH);
assert.equal(sent.from, PAYER);
assert.deepEqual(stages, ["connecting", "network", "confirming"]);
assert.deepEqual(
  provider.calls.map((call) => call.method),
  ["eth_requestAccounts", "eth_chainId", "wallet_switchEthereumChain", "eth_chainId", "eth_sendTransaction"],
);
assert.deepEqual(provider.calls[2].params, [{ chainId: "0x1" }]);
assert.equal(provider.calls[4].params[0].to, USDT.contractAddress);
assert.equal(provider.calls[4].params[0].data, encodeErc20Transfer(DEPOSIT, 50_000_000n));

const onMainnet = fakeProvider({ chainId: "0x1" });
await sendTopUpPayment({ provider: onMainnet, asset: ETH, depositAddress: DEPOSIT, baseUnits: 1n });
assert.equal(onMainnet.calls.some((call) => call.method === "wallet_switchEthereumChain"), false);

await assert.rejects(
  sendTopUpPayment({ provider: fakeProvider({ switchError: { code: 4902 } }), asset: USDC, depositAddress: DEPOSIT, baseUnits: 1n }),
  (error) => mapWalletError(error) === WALLET_ERROR_COPY.wrongNetwork,
);
const rejectedSwitch = fakeProvider({ switchError: { code: 4001 } });
await assert.rejects(
  sendTopUpPayment({ provider: rejectedSwitch, asset: USDC, depositAddress: DEPOSIT, baseUnits: 1n }),
  (error) => mapWalletError(error) === WALLET_ERROR_COPY.rejected,
);
assert.equal(rejectedSwitch.calls.some((call) => call.method === "eth_sendTransaction"), false);
await assert.rejects(
  sendTopUpPayment({ provider: fakeProvider({ sendError: { code: 4001 } }), asset: USDC, depositAddress: DEPOSIT, baseUnits: 1n }),
  (error) => mapWalletError(error) === WALLET_ERROR_COPY.rejected,
);
await assert.rejects(
  sendTopUpPayment({ provider: undefined, asset: USDC, depositAddress: DEPOSIT, baseUnits: 1n }),
  (error) => mapWalletError(error) === WALLET_ERROR_COPY.missing,
);

assert.equal(shortHex(TX_HASH), "0xabab…abab");
assert.equal(etherscanTxUrl(TX_HASH), `https://etherscan.io/tx/${TX_HASH}`);
assert.equal(etherscanTxUrl("0x123"), "");
assert.equal(creditedBaseUnits({ creditedBalances: { USDC: { raw: "25000000" } } }, "USDC"), 25_000_000n);
assert.equal(creditedBaseUnits({ creditedBalances: { USDC: null } }, "USDC"), 0n);
assert.equal(creditedBaseUnits(null, "USDC"), 0n);

console.log("evm wallet pay smoke ok");
