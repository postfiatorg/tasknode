import {
  formatEther,
  formatUnits,
  getAddress,
  HDNodeWallet,
  id as keccakId,
  zeroPadValue,
} from "ethers";
import {
  appendUsageCredit,
  getEthereumDepositAccount,
  getOrCreateEthereumDepositAccount,
  updateEthereumDepositSync,
  usageSummary,
} from "./runtime-store.js";

const defaultEthereumRpcUrl = "https://ethereum.publicnode.com";
const ethereumMainnetChainId = 1;
const defaultReceivePath = "m/44'/60'/0'/0";
const balanceBlockTag = process.env.ETH_DEPOSIT_BALANCE_BLOCK_TAG || "safe";
const pendingBalanceBlockTag = process.env.ETH_DEPOSIT_PENDING_BLOCK_TAG || "latest";
const balanceOfSelector = keccakId("balanceOf(address)").slice(0, 10);

export const ethereumDepositAssets = [
  {
    symbol: "ETH",
    label: "Ether",
    decimals: 18,
    kind: "native",
    contractAddress: null,
    creditPolicy: "ETH is converted to USD using the price available when the safe balance sync credits the deposit.",
  },
  {
    symbol: "USDC",
    label: "USD Coin",
    decimals: 6,
    kind: "erc20",
    contractAddress: getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
    creditPolicy: "Credited 1:1 as USD after the safe token balance increases.",
  },
  {
    symbol: "USDT",
    label: "Tether USD",
    decimals: 6,
    kind: "erc20",
    contractAddress: getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7"),
    creditPolicy: "Credited 1:1 as USD after the safe token balance increases.",
  },
];

function ethereumDepositXpub() {
  return String(process.env.ETH_DEPOSIT_XPUB || process.env.ETHEREUM_DEPOSIT_XPUB || "").trim();
}

function ethereumRpcUrl() {
  return String(process.env.ETH_DEPOSIT_RPC_URL || process.env.ETHEREUM_RPC_URL || defaultEthereumRpcUrl).trim();
}

function receivePathPrefix() {
  return String(process.env.ETH_DEPOSIT_RECEIVE_PATH || defaultReceivePath).trim();
}

export function ethereumDepositConfigStatus() {
  const xpub = ethereumDepositXpub();
  const rpcUrl = ethereumRpcUrl();
  return {
    configured: Boolean(xpub),
    enabled: Boolean(xpub),
    status: xpub ? "ready" : "missing_config",
    chainId: ethereumMainnetChainId,
    network: "Ethereum mainnet",
    rpcConfigured: Boolean(rpcUrl),
    blockTag: balanceBlockTag,
    supportedAssets: ethereumDepositAssets,
    actionRequired: xpub
      ? "Use /api/usage/top-up/start to allocate the account deposit address."
      : "Configure ETH_DEPOSIT_XPUB with the Ethereum receive xpub for m/44'/60'/0'/0 before showing live deposit addresses.",
  };
}

export function deriveEthereumDepositAddress(index) {
  const xpub = ethereumDepositXpub();
  if (!xpub) {
    throw new Error("eth_deposit_xpub_missing");
  }

  const normalizedIndex = Math.max(0, Number(index) || 0);
  const receiveNode = HDNodeWallet.fromExtendedKey(xpub);
  const child = receiveNode.deriveChild(normalizedIndex);
  return {
    address: getAddress(child.address),
    derivationIndex: normalizedIndex,
    derivationPath: `${receivePathPrefix()}/${normalizedIndex}`,
  };
}

export function getOrCreateEthereumTopUpAccount({ accountId = "" } = {}) {
  const status = ethereumDepositConfigStatus();
  if (!accountId) {
    return { ok: false, status: 401, error: "deposit_login_required" };
  }
  if (!status.enabled) {
    return { ok: false, status: 409, error: "eth_deposit_not_configured", config: status };
  }

  const result = getOrCreateEthereumDepositAccount({
    accountId,
    deriveAddress: deriveEthereumDepositAddress,
    assets: ethereumDepositAssets.map(({ symbol }) => symbol),
    chainId: ethereumMainnetChainId,
    network: "Ethereum mainnet",
  });

  if (!result.ok) return result;
  return {
    ok: true,
    created: result.created,
    depositAccount: publicDepositAccount(result.account),
    config: status,
  };
}

export function publicDepositAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    accountId: account.accountId,
    chainId: account.chainId || ethereumMainnetChainId,
    network: account.network || "Ethereum mainnet",
    address: account.address,
    derivationIndex: account.derivationIndex,
    derivationPath: account.derivationPath,
    status: account.status || "active",
    custody: account.custody || "tasknode_deposit_only",
    withdrawalsEnabled: account.withdrawalsEnabled === true,
    sweepStatus: account.sweepStatus || "deferred",
    observedBalances: account.observedBalances || {},
    pendingBalances: account.pendingBalances || {},
    creditedBalances: account.creditedBalances || {},
    lastSyncAt: account.lastSyncAt || null,
    lastSyncStatus: account.lastSyncStatus || "not_synced",
    lastSyncError: account.lastSyncError || "",
    assets: ethereumDepositAssets,
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function rpcCall(method, params = []) {
  const response = await fetchWithTimeout(ethereumRpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
  });
  const body = await response.json();
  if (!response.ok || body?.error) {
    const error = new Error(body?.error?.message || `Ethereum RPC ${method} failed`);
    error.status = response.status || 502;
    throw error;
  }
  return body.result;
}

async function ethUsdPrice() {
  const configured = Number(process.env.ETH_DEPOSIT_ETH_USD_PRICE || process.env.ETH_USD_PRICE || 0);
  if (Number.isFinite(configured) && configured > 0) return configured;

  const response = await fetchWithTimeout(
    "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    { headers: { accept: "application/json" } },
    8000
  );
  const body = await response.json();
  const price = Number(body?.ethereum?.usd || 0);
  if (!response.ok || !Number.isFinite(price) || price <= 0) {
    throw new Error("eth_usd_price_unavailable");
  }
  return price;
}

function balanceOfCalldata(address) {
  return `${balanceOfSelector}${zeroPadValue(address, 32).slice(2)}`;
}

function rawHexToBigInt(value) {
  const text = String(value || "0x0");
  if (!/^0x[0-9a-f]*$/i.test(text)) return 0n;
  return BigInt(text || "0x0");
}

async function readAssetBalance(asset, address, blockTag = balanceBlockTag) {
  if (asset.kind === "native") {
    const raw = rawHexToBigInt(await rpcCall("eth_getBalance", [address, blockTag]));
    return {
      symbol: asset.symbol,
      raw,
      amount: formatEther(raw),
      decimals: asset.decimals,
    };
  }

  const raw = rawHexToBigInt(await rpcCall("eth_call", [
    {
      to: asset.contractAddress,
      data: balanceOfCalldata(address),
    },
    blockTag,
  ]));
  return {
    symbol: asset.symbol,
    raw,
    amount: formatUnits(raw, asset.decimals),
    decimals: asset.decimals,
  };
}

function formattedBalance(balance, blockTag = balanceBlockTag) {
  return {
    raw: balance.raw.toString(),
    amount: balance.amount,
    decimals: balance.decimals,
    syncedAt: new Date().toISOString(),
    blockTag: balanceBlockTag,
  };
}

function decimalAmount(raw, decimals) {
  return Number(formatUnits(raw, decimals));
}

async function creditDelta({ account, asset, currentRaw, creditedRaw }) {
  const deltaRaw = currentRaw - creditedRaw;
  if (deltaRaw <= 0n) return null;

  const assetAmount = decimalAmount(deltaRaw, asset.decimals);
  let amountUsd = assetAmount;
  const metadata = {
    chain: "ethereum",
    chainId: ethereumMainnetChainId,
    network: "Ethereum mainnet",
    asset: asset.symbol,
    depositAddress: account.address,
    depositAccountId: account.id,
    rawAmount: deltaRaw.toString(),
    creditedBalanceRaw: currentRaw.toString(),
    blockTag: balanceBlockTag,
  };

  if (asset.symbol === "ETH") {
    const price = await ethUsdPrice();
    amountUsd = assetAmount * price;
    metadata.ethUsdPrice = price;
  }

  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return null;

  return appendUsageCredit({
    accountId: account.accountId,
    amountUsd,
    source: "ethereum_deposit",
    note: `${assetAmount.toFixed(asset.symbol === "ETH" ? 8 : 2)} ${asset.symbol} deposit`,
    createdBy: "ethereum_deposit_sync",
    uniqueKey: `ethereum_deposit:${account.id}:${asset.symbol}:${currentRaw.toString()}`,
    metadata,
  });
}

export async function syncEthereumTopUpAccount({ accountId = "" } = {}) {
  const setup = getOrCreateEthereumTopUpAccount({ accountId });
  if (!setup.ok) return setup;

  const account = getEthereumDepositAccount({ accountId });
  const observedBalances = {};
  const pendingBalances = {};
  const creditedBalances = {};
  const creditedEntries = [];
  const syncErrors = [];

  try {
    for (const asset of ethereumDepositAssets) {
      let balance = null;
      let pendingBalance = null;
      try {
        balance = await readAssetBalance(asset, account.address, balanceBlockTag);
        observedBalances[asset.symbol] = formattedBalance(balance, balanceBlockTag);
      } catch (error) {
        syncErrors.push(`${asset.symbol}: ${error?.message || "balance_unavailable"}`);
        continue;
      }
      try {
        pendingBalance = await readAssetBalance(asset, account.address, pendingBalanceBlockTag);
        if (pendingBalance.raw > balance.raw) {
          pendingBalances[asset.symbol] = {
            ...formattedBalance(pendingBalance, pendingBalanceBlockTag),
            blockTag: pendingBalanceBlockTag,
            safeRaw: balance.raw.toString(),
            safeAmount: balance.amount,
          };
        } else {
          pendingBalances[asset.symbol] = null;
        }
      } catch {
        pendingBalance = null;
      }

      const creditedRaw = BigInt(account.creditedBalances?.[asset.symbol]?.raw || "0");
      let entry = null;
      try {
        entry = await creditDelta({
          account,
          asset,
          currentRaw: balance.raw,
          creditedRaw,
        });
        if (entry) creditedEntries.push(entry);
      } catch (error) {
        syncErrors.push(`${asset.symbol}: ${error?.message || "credit_unavailable"}`);
      }

      if (balance.raw > creditedRaw && (asset.symbol !== "ETH" || entry)) {
        creditedBalances[asset.symbol] = formattedBalance(balance);
      }
    }

    if (Object.keys(observedBalances).length === 0 && syncErrors.length > 0) {
      throw new Error(syncErrors.join("; "));
    }

    const updated = updateEthereumDepositSync({
      accountId,
      observedBalances,
      pendingBalances,
      creditedBalances,
      syncStatus: syncErrors.length > 0 ? "partial" : "ready",
      syncError: syncErrors.join("; "),
      blockTag: balanceBlockTag,
      creditedEntries,
    });
    const usage = usageSummary({ accountId });
    return {
      ok: true,
      action: "top_up_sync",
      message: creditedEntries.length > 0
        ? "Deposit credit recorded."
        : syncErrors.length > 0
          ? "Deposit sync completed with partial data."
          : "No new confirmed deposit balance found.",
      depositAccount: publicDepositAccount(updated || account),
      creditedEntries,
      syncErrors,
      pendingBalances,
      usage: {
        billingModel: "usage_based",
        currency: "USD",
        currentSpendUsd: usage.currentSpendUsd,
        currentCreditUsd: usage.currentCreditUsd,
        availableCreditUsd: usage.availableCreditUsd,
      },
    };
  } catch (error) {
    const updated = updateEthereumDepositSync({
      accountId,
      observedBalances,
      pendingBalances,
      syncStatus: "error",
      syncError: error?.message || "ethereum_deposit_sync_failed",
      blockTag: balanceBlockTag,
      creditedEntries,
    });
    return {
      ok: false,
      status: error?.status || 502,
      error: error?.message || "ethereum_deposit_sync_failed",
      action: "top_up_sync",
      message: "Ethereum deposit sync could not complete.",
      depositAccount: publicDepositAccount(updated || account),
    };
  }
}
