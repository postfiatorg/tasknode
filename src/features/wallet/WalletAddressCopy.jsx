import { useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { shortWalletAddress } from "./WalletComponents";
import { copyLinkedWalletAddress } from "./wallet-state";

export function WalletAddressCopy({ address, copyRef, linked }) {
  const [status, setStatus] = useState("idle");
  const attempt = useRef(0);
  const manualAddress = useRef(null);
  const manualId = useId();

  useEffect(() => () => { attempt.current += 1; }, []);

  useEffect(() => {
    if (status === "manual") {
      manualAddress.current?.focus();
      manualAddress.current?.select();
    }
    if (status !== "copied") return undefined;
    const timer = window.setTimeout(() => setStatus("idle"), 1400);
    return () => window.clearTimeout(timer);
  }, [status]);

  const copyAddress = useCallback(async () => {
    if (!linked || !address || status === "pending") return;
    const capturedAttempt = ++attempt.current;
    setStatus("pending");
    const result = await copyLinkedWalletAddress({
      address,
      linked,
      getClipboard: () => globalThis.navigator?.clipboard,
      isCurrent: () => attempt.current === capturedAttempt,
    });
    if (result !== "stale") setStatus(result === "unlinked" ? "idle" : result);
  }, [address, linked, status]);

  useImperativeHandle(copyRef, () => ({ copyAddress }), [copyAddress]);

  return (
    <div className="wallet-address-copy">
      <button
        aria-label={linked ? "Copy full wallet address" : "No wallet linked"}
        className="address-chip wallet-address-chip"
        disabled={!linked || !address || status === "pending"}
        onClick={copyAddress}
        type="button"
      >
        <span className={linked ? "wallet-address-dot is-linked" : "wallet-address-dot"} />
        <span>{linked ? shortWalletAddress(address) : "No wallet linked"}</span>
        {status === "copied" ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.8} />}
      </button>
      <span className="wallet-copy-status" role="status">
        {status === "copied" ? "Wallet address copied." : ""}
      </span>
      {status === "manual" && (
        <div className="wallet-address-manual">
          <label htmlFor={manualId}>Full wallet address</label>
          <input id={manualId} ref={manualAddress} readOnly type="text" value={address} />
          <span role="status">Copy is unavailable. Select and copy the full address.</span>
        </div>
      )}
    </div>
  );
}
