// Pure helpers for paying a Task Node top-up from an injected EVM wallet
// (MetaMask). No ethers/viem: amounts are BigInt base units and ERC-20
// calldata is encoded by hand, so nothing here touches floating point.

export const ETHEREUM_MAINNET_CHAIN_ID = "0x1";
export const ERC20_TRANSFER_SELECTOR = "a9059cbb";
export const METAMASK_DOWNLOAD_URL = "https://metamask.io/download/";
export const ETHERSCAN_TX_URL = "https://etherscan.io/tx/";

const METAMASK_RDNS = new Set(["io.metamask", "io.metamask.flask"]);
const UINT256_MAX = (1n << 256n) - 1n;
const DEFAULT_DECIMALS = { ETH: 18, USDC: 6, USDT: 6 };
const USD_STABLECOINS = new Set(["USDC", "USDT"]);
// Per-payment ceiling for the wallet flow. Larger deposits can still use the
// manual address.
const MAX_PAYMENT = { ETH: "5", USDC: "10000", USDT: "10000" };

export const WALLET_ERROR_COPY = {
  rejected: "You cancelled the request in MetaMask. Nothing was sent.",
  wrongNetwork: "MetaMask is on another network. Switch to Ethereum mainnet and try again.",
  gas: "This wallet needs a little ETH to pay the network fee. Nothing was sent.",
  ethBalance: "This wallet needs more ETH to cover the amount and the network fee. Nothing was sent.",
  pending: "MetaMask already has a request open. Finish it in MetaMask, then try again.",
  unauthorized: "Unlock MetaMask and connect it to Task Node, then try again.",
  missing: "MetaMask isn't available in this browser.",
  noAccount: "MetaMask didn't share an account. Unlock MetaMask and try again.",
  badResponse: "MetaMask returned an unexpected response. Check MetaMask activity before paying again.",
  generic: "MetaMask couldn't send the payment. Nothing was sent.",
};

function hexBody(value, length) {
  if (typeof value !== "string" || !value.startsWith("0x") || value.length !== length + 2) return false;
  for (const character of value.slice(2).toLowerCase()) {
    if (!"0123456789abcdef".includes(character)) return false;
  }
  return true;
}

export function isEvmAddress(value) {
  return hexBody(value, 40);
}

export function isTransactionHash(value) {
  return hexBody(value, 64);
}

export function shortHex(value = "", head = 6, tail = 4) {
  const text = String(value || "");
  return text.length > head + tail + 1 ? `${text.slice(0, head)}…${text.slice(-tail)}` : text;
}

export function etherscanTxUrl(hash) {
  return isTransactionHash(hash) ? `${ETHERSCAN_TX_URL}${hash}` : "";
}

export function assetDecimals(asset) {
  const decimals = Number(asset?.decimals ?? DEFAULT_DECIMALS[asset?.symbol]);
  return Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : null;
}

export function isUsdStablecoin(asset) {
  return asset?.kind === "erc20" && USD_STABLECOINS.has(asset?.symbol);
}

export function isWalletPayableAsset(asset) {
  if (assetDecimals(asset) === null) return false;
  if (asset?.kind === "native") return true;
  return asset?.kind === "erc20" && isEvmAddress(asset?.contractAddress);
}

function amountError(message) {
  const error = new Error(message);
  error.code = "TN_INVALID_AMOUNT";
  return error;
}

// "25.5" with 6 decimals -> 25500000n. Rejects signs, exponents, separators,
// and more fractional digits than the asset supports.
export function parseAmountToBaseUnits(input, decimals) {
  const places = Number(decimals);
  if (!Number.isSafeInteger(places) || places < 0 || places > 36) {
    throw amountError("This asset has unsupported decimals.");
  }
  const text = String(input ?? "").trim();
  if (!text) throw amountError("Enter an amount.");
  if (text.startsWith("-")) throw amountError("Enter an amount greater than zero.");
  if (text.length > 48) throw amountError("Enter a smaller amount.");
  const [whole = "", fraction = "", ...rest] = text.split(".");
  const digitsOnly = (part) => [...part].every((character) => character >= "0" && character <= "9");
  if (rest.length > 0 || (!whole && !fraction) || !digitsOnly(whole) || !digitsOnly(fraction)) {
    throw amountError("Enter a number, like 25 or 25.50.");
  }
  if (fraction.length > places) {
    throw amountError(places === 0 ? "Enter a whole number." : `Use up to ${places} decimal places.`);
  }
  const value = BigInt(whole || "0") * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, "0") || "0");
  if (value <= 0n) throw amountError("Enter an amount greater than zero.");
  return value;
}

export function formatBaseUnits(value, decimals) {
  const amount = BigInt(value);
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const places = Number(decimals);
  const base = 10n ** BigInt(places);
  let fraction = places > 0 ? (magnitude % base).toString().padStart(places, "0") : "";
  while (fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `${negative ? "-" : ""}${magnitude / base}${fraction ? `.${fraction}` : ""}`;
}

export function maxPaymentLabel(asset) {
  const limit = MAX_PAYMENT[asset?.symbol];
  if (!limit) return "";
  const grouped = Number(limit).toLocaleString("en-US");
  return isUsdStablecoin(asset) ? `$${grouped}` : `${grouped} ${asset.symbol}`;
}

// Returns { ok, baseUnits, error } so the form can validate on every keystroke.
export function validateTopUpAmount(amount, asset) {
  const decimals = assetDecimals(asset);
  if (!isWalletPayableAsset(asset)) {
    return { ok: false, baseUnits: 0n, error: `${asset?.symbol || "This asset"} can't be paid from MetaMask.` };
  }
  let baseUnits;
  try {
    baseUnits = parseAmountToBaseUnits(amount, decimals);
  } catch (error) {
    const message = error.message.startsWith("Use up to")
      ? `${asset.symbol} supports up to ${decimals} decimal places.`
      : error.message;
    return { ok: false, baseUnits: 0n, error: message };
  }
  const limit = MAX_PAYMENT[asset.symbol];
  if (limit && baseUnits > parseAmountToBaseUnits(limit, decimals)) {
    return { ok: false, baseUnits, error: `Enter up to ${maxPaymentLabel(asset)} per payment.` };
  }
  return { ok: true, baseUnits, error: "" };
}

export function toHexQuantity(value) {
  const amount = BigInt(value);
  if (amount < 0n || amount > UINT256_MAX) throw new Error("Quantity is out of range.");
  return `0x${amount.toString(16)}`;
}

export function encodeErc20Transfer(recipient, amount) {
  if (!isEvmAddress(recipient)) throw new Error("The deposit address is not a valid Ethereum address.");
  const value = BigInt(amount);
  if (value <= 0n || value > UINT256_MAX) throw new Error("Transfer amount is out of range.");
  const recipientWord = recipient.slice(2).toLowerCase().padStart(64, "0");
  const amountWord = value.toString(16).padStart(64, "0");
  return `0x${ERC20_TRANSFER_SELECTOR}${recipientWord}${amountWord}`;
}

// chainId is included so MetaMask refuses to sign if the active network
// changed between the switch and the send.
export function buildTopUpTransaction({ asset, from, depositAddress, baseUnits }) {
  if (!isEvmAddress(from)) throw new Error("MetaMask returned an invalid account.");
  if (!isEvmAddress(depositAddress)) throw new Error("The deposit address is not a valid Ethereum address.");
  if (!isWalletPayableAsset(asset)) throw new Error(`${asset?.symbol || "This asset"} can't be paid from MetaMask.`);
  if (BigInt(baseUnits) <= 0n) throw new Error("Enter an amount greater than zero.");
  if (asset.kind === "native") {
    return { from, to: depositAddress, value: toHexQuantity(baseUnits), chainId: ETHEREUM_MAINNET_CHAIN_ID };
  }
  return {
    from,
    to: asset.contractAddress,
    value: "0x0",
    data: encodeErc20Transfer(depositAddress, baseUnits),
    chainId: ETHEREUM_MAINNET_CHAIN_ID,
  };
}

function isMetaMaskProvider(provider) {
  return Boolean(provider && typeof provider.request === "function" && provider.isMetaMask && !provider.isPhantom);
}

// Prefers an EIP-6963 announcement from MetaMask, then the MetaMask entry in
// window.ethereum.providers, then window.ethereum itself. Phantom also sets
// isMetaMask, so it is skipped explicitly.
export function selectMetaMaskProvider({ injected, announced = [] } = {}) {
  const fromAnnouncement = (Array.isArray(announced) ? announced : []).find(
    (detail) => METAMASK_RDNS.has(detail?.info?.rdns) && isMetaMaskProvider(detail?.provider),
  )?.provider;
  if (fromAnnouncement) return fromAnnouncement;
  const providers = Array.isArray(injected?.providers) ? injected.providers : [];
  return providers.find(isMetaMaskProvider) ?? (isMetaMaskProvider(injected) ? injected : undefined);
}

// Wallets answer eip6963:requestProvider synchronously from their own
// listener, so a dispatch inside this call collects every announcement.
export function collectAnnouncedProviders(target = globalThis.window) {
  const announced = [];
  if (!target?.addEventListener || typeof Event === "undefined") return announced;
  const onAnnounce = (event) => {
    if (event?.detail?.provider) announced.push(event.detail);
  };
  target.addEventListener("eip6963:announceProvider", onAnnounce);
  try {
    target.dispatchEvent(new Event("eip6963:requestProvider"));
  } finally {
    target.removeEventListener("eip6963:announceProvider", onAnnounce);
  }
  return announced;
}

export function detectMetaMaskProvider(target = globalThis.window) {
  return selectMetaMaskProvider({ injected: target?.ethereum, announced: collectAnnouncedProviders(target) });
}

export function walletError(code, message = "", cause = undefined) {
  const error = new Error(message || code);
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function errorChain(error) {
  const chain = [];
  const queue = [error];
  while (queue.length > 0 && chain.length < 8) {
    const item = queue.shift();
    if (!item || typeof item !== "object" || chain.includes(item)) continue;
    chain.push(item);
    queue.push(item.error, item.data, item.data?.originalError, item.info?.error, item.cause);
  }
  return chain;
}

function errorCodes(error) {
  return errorChain(error).map((item) => item.code).filter((code) => code !== undefined && code !== null);
}

function errorText(error) {
  const messages = errorChain(error).flatMap((item) => [item.message, item.reason, item.shortMessage]);
  if (typeof error === "string") messages.push(error);
  return messages.filter((text) => typeof text === "string").join(" ").toLowerCase();
}

export function isUserRejection(error) {
  const codes = errorCodes(error);
  if (codes.includes(4001) || codes.includes("4001") || codes.includes("ACTION_REJECTED")) return true;
  const text = errorText(error);
  return text.includes("user rejected") || text.includes("user denied") || text.includes("user cancelled");
}

export function mapWalletError(error, { assetSymbol = "" } = {}) {
  const codes = errorCodes(error);
  const text = errorText(error);
  if (isUserRejection(error)) return WALLET_ERROR_COPY.rejected;
  if (codes.includes("TN_NO_METAMASK")) return WALLET_ERROR_COPY.missing;
  if (codes.includes("TN_NO_ACCOUNT")) return WALLET_ERROR_COPY.noAccount;
  if (codes.includes("TN_BAD_RESPONSE")) return WALLET_ERROR_COPY.badResponse;
  if (codes.includes("TN_INVALID_AMOUNT")) return error.message;
  if (
    codes.includes("TN_WRONG_NETWORK") ||
    codes.includes(4902) ||
    text.includes("chainid") ||
    text.includes("chain id") ||
    text.includes("unrecognized chain")
  ) {
    return WALLET_ERROR_COPY.wrongNetwork;
  }
  if (codes.includes(-32002) || text.includes("already pending")) return WALLET_ERROR_COPY.pending;
  if (codes.includes(4100)) return WALLET_ERROR_COPY.unauthorized;
  if (
    text.includes("insufficient funds") ||
    text.includes("intrinsic transaction cost") ||
    text.includes("gas required exceeds")
  ) {
    return assetSymbol === "ETH" ? WALLET_ERROR_COPY.ethBalance : WALLET_ERROR_COPY.gas;
  }
  if (text.includes("exceeds balance") && assetSymbol) {
    return `This wallet holds less ${assetSymbol} than that amount. Nothing was sent.`;
  }
  return WALLET_ERROR_COPY.generic;
}

export function isMainnetChainId(value) {
  try {
    return BigInt(value) === 1n;
  } catch {
    return false;
  }
}

export async function ensureEthereumMainnet(provider) {
  if (isMainnetChainId(await provider.request({ method: "eth_chainId" }))) return;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ETHEREUM_MAINNET_CHAIN_ID }],
    });
  } catch (error) {
    if (isUserRejection(error) || errorCodes(error).includes(-32002)) throw error;
    throw walletError("TN_WRONG_NETWORK", "", error);
  }
  if (!isMainnetChainId(await provider.request({ method: "eth_chainId" }))) {
    throw walletError("TN_WRONG_NETWORK");
  }
}

// connect -> Ethereum mainnet -> eth_sendTransaction. onStage receives
// "connecting" | "network" | "confirming" so the UI can label each wait.
export async function sendTopUpPayment({ provider, asset, depositAddress, baseUnits, onStage = () => {} }) {
  if (!provider || typeof provider.request !== "function") throw walletError("TN_NO_METAMASK");
  onStage("connecting");
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const from = Array.isArray(accounts) ? accounts[0] : "";
  if (!isEvmAddress(from)) throw walletError("TN_NO_ACCOUNT");
  onStage("network");
  await ensureEthereumMainnet(provider);
  const transaction = buildTopUpTransaction({ asset, from, depositAddress, baseUnits });
  onStage("confirming");
  const txHash = await provider.request({ method: "eth_sendTransaction", params: [transaction] });
  if (!isTransactionHash(txHash)) throw walletError("TN_BAD_RESPONSE");
  return { from, txHash, transaction };
}

export function creditedBaseUnits(depositAccount, symbol) {
  try {
    return BigInt(depositAccount?.creditedBalances?.[symbol]?.raw || "0");
  } catch {
    return 0n;
  }
}
