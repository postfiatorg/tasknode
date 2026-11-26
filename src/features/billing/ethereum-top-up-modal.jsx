import { useId, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronDown, Copy, RefreshCw, X } from "lucide-react";
import {
  assetDecimals,
  creditedBaseUnits,
  detectMetaMaskProvider,
  etherscanTxUrl,
  formatBaseUnits,
  isUsdStablecoin,
  isWalletPayableAsset,
  mapWalletError,
  METAMASK_DOWNLOAD_URL,
  sendTopUpPayment,
  shortHex,
  validateTopUpAmount,
} from "./evm-wallet-pay";
import "../wallet/wallet.css";
import "./ethereum-top-up.css";

const ASSET_ORDER = ["USDC", "USDT", "ETH"];
const USD_QUICK_AMOUNTS = ["10", "25", "50", "100"];
const ETH_QUICK_AMOUNTS = ["0.005", "0.01", "0.025", "0.05"];
const DEFAULT_USD_AMOUNT = "25";
const DEFAULT_ETH_AMOUNT = "0.01";
const PAYMENT_STAGE_LABELS = {
  connecting: "Connecting to MetaMask…",
  network: "Switching to Ethereum…",
  confirming: "Confirm in MetaMask…",
};

function hasMetaMask() {
  return Boolean(detectMetaMaskProvider());
}

export function EthereumTopUpModal({ onClose, onRefresh, state }) {
  const [metaMaskReady, setMetaMaskReady] = useState(hasMetaMask);
  const [manualOpen, setManualOpen] = useState(() => !hasMetaMask());
  const deposit = state?.data?.depositAccount || null;
  const busy = state?.status === "loading" || state?.status === "syncing";
  const error = state?.status === "error";

  return (
    <div className="modal-backdrop chat-edit-backdrop" onClick={onClose} role="presentation">
      <div
        aria-label="Top up account"
        aria-modal="true"
        className="wallet-link-modal eth-topup-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <div>
            <h2>Top up</h2>
            <p>Add credit with USDC, USDT, or ETH on Ethereum mainnet.</p>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="Close top up">
            <X size={16} strokeWidth={2} />
          </button>
        </header>

        {busy && !deposit && (
          <div className="eth-topup-loading">
            <RefreshCw size={16} strokeWidth={2} />
            Preparing deposit address
          </div>
        )}

        {error && <div className="wallet-link-warning">{state?.message || "Top-up is unavailable."}</div>}

        {deposit && (
          <>
            <WalletPayPanel
              data={state.data}
              metaMaskReady={metaMaskReady}
              onMetaMaskMissing={() => {
                setMetaMaskReady(false);
                setManualOpen(true);
              }}
              onRefresh={onRefresh}
            />
            <ManualDepositPanel
              deposit={deposit}
              message={state?.message || ""}
              onRefresh={onRefresh}
              onToggle={() => setManualOpen((current) => !current)}
              open={manualOpen}
              syncing={state?.status === "syncing"}
            />
          </>
        )}

        <footer>
          <button className="ghost-button" onClick={onClose} type="button">
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

function WalletPayPanel({ data, metaMaskReady, onMetaMaskMissing, onRefresh }) {
  const deposit = data?.depositAccount;
  const usage = data?.usage;
  const payableAssets = useMemo(() => orderedPayableAssets(deposit?.assets), [deposit?.assets]);
  const [symbol, setSymbol] = useState(() => (payableAssets.some((item) => item.symbol === "USDC") ? "USDC" : payableAssets[0]?.symbol));
  const asset = payableAssets.find((item) => item.symbol === symbol) || payableAssets[0] || null;
  const usd = isUsdStablecoin(asset);
  const [amount, setAmount] = useState(() => (asset && !usd ? DEFAULT_ETH_AMOUNT : DEFAULT_USD_AMOUNT));
  const [payment, setPayment] = useState({ status: "idle" });
  const inFlightRef = useRef(false);
  const amountId = useId();
  const hintId = useId();

  if (!asset) return null;

  const validation = validateTopUpAmount(amount, asset);
  const showAmountError = Boolean(amount.trim()) && !validation.ok;
  const paying = Boolean(PAYMENT_STAGE_LABELS[payment.status]);
  const submitted = payment.status === "submitted";
  const credited = submitted && creditedBaseUnits(deposit, payment.symbol) > payment.baselineRaw;
  const waiting = submitted && !credited;
  const quickAmounts = usd ? USD_QUICK_AMOUNTS : ETH_QUICK_AMOUNTS;

  function selectAsset(next) {
    if (next.symbol === asset.symbol || paying) return;
    if (isUsdStablecoin(next) !== usd) setAmount(isUsdStablecoin(next) ? DEFAULT_USD_AMOUNT : DEFAULT_ETH_AMOUNT);
    setSymbol(next.symbol);
    if (payment.status === "error") setPayment({ status: "idle" });
  }

  async function pay(event) {
    event.preventDefault();
    if (inFlightRef.current || paying || waiting) return;
    if (!validation.ok) {
      setPayment({ status: "error", message: validation.error });
      return;
    }
    const provider = detectMetaMaskProvider();
    if (!provider) {
      onMetaMaskMissing();
      return;
    }

    inFlightRef.current = true;
    const baselineRaw = creditedBaseUnits(deposit, asset.symbol);
    const baselineCreditUsd = Number(usage?.currentCreditUsd);
    setPayment({ status: "connecting" });
    try {
      const { txHash } = await sendTopUpPayment({
        provider,
        asset,
        depositAddress: deposit.address,
        baseUnits: validation.baseUnits,
        onStage: (stage) => setPayment({ status: stage }),
      });
      setPayment({
        status: "submitted",
        txHash,
        symbol: asset.symbol,
        decimals: assetDecimals(asset),
        usd,
        baselineRaw,
        baselineCreditUsd,
      });
      onRefresh?.({ silent: true });
    } catch (error) {
      setPayment({ status: "error", message: mapWalletError(error, { assetSymbol: asset.symbol }) });
    } finally {
      inFlightRef.current = false;
    }
  }

  return (
    <form className="eth-topup-pay-form" noValidate onSubmit={pay}>
      <div className="eth-topup-segment" role="group" aria-label="Asset">
        {payableAssets.map((item) => (
          <button
            aria-pressed={item.symbol === asset.symbol}
            disabled={paying}
            key={item.symbol}
            onClick={() => selectAsset(item)}
            type="button"
          >
            {item.symbol}
          </button>
        ))}
      </div>

      <div className="eth-topup-field">
        <div className="eth-topup-field-head">
          <label htmlFor={amountId}>Amount</label>
          <div className="eth-topup-quick" role="group" aria-label="Quick amounts">
            {quickAmounts.map((value) => (
              <button
                aria-pressed={amount.trim() === value}
                disabled={paying}
                key={value}
                onClick={() => setAmount(value)}
                type="button"
              >
                {usd ? `$${value}` : value}
              </button>
            ))}
          </div>
        </div>
        <div className={showAmountError ? "eth-topup-amount invalid" : "eth-topup-amount"}>
          {usd && <span aria-hidden="true">$</span>}
          <input
            aria-describedby={hintId}
            aria-invalid={showAmountError}
            autoComplete="off"
            disabled={paying}
            id={amountId}
            inputMode="decimal"
            onChange={(event) => {
              setAmount(event.target.value);
              if (payment.status === "error") setPayment({ status: "idle" });
            }}
            placeholder="0"
            spellCheck={false}
            type="text"
            value={amount}
          />
          <span>{asset.symbol}</span>
        </div>
        <small className={showAmountError ? "eth-topup-hint error" : "eth-topup-hint"} id={hintId}>
          {showAmountError ? validation.error : creditNote(asset)}
        </small>
      </div>

      {metaMaskReady ? (
        <button className="solid-button eth-topup-pay" disabled={paying || waiting || !validation.ok} type="submit">
          {paying ? PAYMENT_STAGE_LABELS[payment.status] : waiting ? "Waiting for confirmation" : "Pay with MetaMask"}
        </button>
      ) : (
        <div className="eth-topup-install">
          <a className="solid-button eth-topup-pay" href={METAMASK_DOWNLOAD_URL} rel="noopener noreferrer" target="_blank">
            Install MetaMask
            <ArrowUpRight size={15} strokeWidth={2} />
          </a>
          <small>Reload this page after installing, or send manually below.</small>
        </div>
      )}

      <div aria-live="polite" className="eth-topup-pay-status">
        {payment.status === "error" && <p className="error">{payment.message}</p>}
        {submitted && (
          <>
            {credited && (
              <p className="success">
                <Check size={14} strokeWidth={2.2} />
                {creditedSummary(payment, deposit, usage)}
              </p>
            )}
            <p>
              Submitted ·{" "}
              <a href={etherscanTxUrl(payment.txHash)} rel="noopener noreferrer" target="_blank">
                {shortHex(payment.txHash)}
                <ArrowUpRight size={12} strokeWidth={2} />
              </a>
            </p>
            {waiting && (
              <p className="muted">
                Credit appears here once Ethereum confirms it.
                <button className="eth-topup-text-button" onClick={() => setPayment({ status: "idle" })} type="button">
                  New payment
                </button>
              </p>
            )}
            {credited && data?.pftGrant?.message && <p className="muted">{data.pftGrant.message}</p>}
          </>
        )}
      </div>
    </form>
  );
}

function ManualDepositPanel({ deposit, message, onRefresh, onToggle, open, syncing }) {
  const [copied, setCopied] = useState(false);
  const [checked, setChecked] = useState(false);
  const bodyId = useId();
  const assets = deposit?.assets || [];

  async function copyDepositAddress() {
    if (!deposit?.address) return;
    try {
      await navigator.clipboard?.writeText(deposit.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="eth-topup-manual">
      <button aria-controls={bodyId} aria-expanded={open} className="eth-topup-disclosure" onClick={onToggle} type="button">
        Send manually
        <ChevronDown size={15} strokeWidth={2} />
      </button>
      {open && (
        <div className="eth-topup-manual-body" id={bodyId}>
          <div className="eth-topup-address">
            <span>Deposit address · Ethereum mainnet</span>
            <button
              aria-label={copied ? "Deposit address copied" : `Copy deposit address ${deposit.address}`}
              onClick={copyDepositAddress}
              type="button"
            >
              <strong>{deposit.address}</strong>
              {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.8} />}
            </button>
          </div>

          <ul className="eth-topup-asset-list" aria-label="Supported top-up assets">
            {assets.map((asset) => (
              <li key={asset.symbol}>
                <strong>{asset.symbol}</strong>
                <span>{asset.kind === "native" ? "Native ETH" : shortEthereumAddress(asset.contractAddress)}</span>
                <em className={deposit?.pendingBalances?.[asset.symbol] ? "pending" : ""}>
                  {formatDepositAssetBalance(deposit, asset.symbol)}
                </em>
              </li>
            ))}
          </ul>

          <p className="eth-topup-fineprint">
            Mainnet only. Task Node controls this deposit-only address: withdrawals are unavailable and wrong-chain
            deposits may be unrecoverable.
          </p>

          <div className="eth-topup-manual-foot">
            <button
              className="eth-topup-text-button"
              disabled={syncing}
              onClick={() => {
                setChecked(true);
                onRefresh?.();
              }}
              type="button"
            >
              {syncing ? "Checking…" : "Check for deposits"}
            </button>
            {checked && !syncing && message && <span>{message}</span>}
          </div>
        </div>
      )}
    </section>
  );
}

function orderedPayableAssets(assets = []) {
  const rank = (symbol) => {
    const index = ASSET_ORDER.indexOf(symbol);
    return index === -1 ? ASSET_ORDER.length : index;
  };
  return (Array.isArray(assets) ? assets : [])
    .filter(isWalletPayableAsset)
    .sort((left, right) => rank(left.symbol) - rank(right.symbol));
}

function creditNote(asset) {
  if (asset.symbol === "USDC") return "Credited 1:1 in USD. Over $10 unlocks the 12 PFT grant for a new linked wallet.";
  if (isUsdStablecoin(asset)) return "Credited 1:1 in USD.";
  return `Credited in USD at the ${asset.symbol} price when it lands.`;
}

function formatUsd(value) {
  if (value === null || value === undefined || value === "") return "";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function creditedSummary(payment, deposit, usage) {
  const assetAmount = formatBaseUnits(creditedBaseUnits(deposit, payment.symbol) - payment.baselineRaw, payment.decimals);
  const creditUsd = Number(usage?.currentCreditUsd) - payment.baselineCreditUsd;
  const usdText = payment.usd ? formatUsd(assetAmount) : creditUsd > 0 ? formatUsd(creditUsd) : "";
  const creditedText = payment.usd ? usdText : `${assetAmount} ${payment.symbol}${usdText ? ` (${usdText})` : ""}`;
  const balance = formatUsd(usage?.availableCreditUsd);
  return `Credited ${creditedText}.${balance ? ` Balance ${balance}.` : ""}`;
}

function shortEthereumAddress(address = "") {
  const text = String(address || "").trim();
  if (!text) return "";
  if (text.length <= 16) return text;
  return `${text.slice(0, 8)}…${text.slice(-6)}`;
}

function formatDepositAssetBalance(deposit, symbol) {
  const credited = deposit?.creditedBalances?.[symbol];
  const observed = deposit?.observedBalances?.[symbol];
  const pending = deposit?.pendingBalances?.[symbol];
  if (credited?.amount && Number(credited.amount) > 0) {
    return `Credited ${formatDepositAmount(credited.amount, symbol)}`;
  }
  if (pending?.amount && Number(pending.amount) > 0) {
    return `Pending ${formatDepositAmount(pending.amount, symbol)}`;
  }
  if (observed?.amount && Number(observed.amount) > 0) {
    return `Seen ${formatDepositAmount(observed.amount, symbol)}, not credited`;
  }
  return "Not seen";
}

function formatDepositAmount(value, symbol) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return `${value} ${symbol}`;
  const options = symbol === "ETH"
    ? { maximumFractionDigits: 8 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 6 };
  return `${amount.toLocaleString(undefined, options)} ${symbol}`;
}
