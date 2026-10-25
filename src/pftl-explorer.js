// The explorer serves accounts at /accounts/:id (explorer ACCOUNT_ROUTE), so a
// wallet link must carry that segment; a bare `<base>/<address>` lands on the
// explorer's not-found page. A base containing `{address}` is used verbatim.
export function walletExplorerHref(walletAddress = "", explorerBase = "") {
  const address = String(walletAddress || "").trim();
  const base = String(explorerBase || "").trim();
  if (!address || !base) return "";
  const encoded = encodeURIComponent(address);
  if (base.includes("{address}")) return base.replace("{address}", encoded);
  if (base.includes("{account}")) return base.replace("{account}", encoded);
  return `${base.replace(/\/+$/, "")}/accounts/${encoded}`;
}

export function transactionExplorerHref(txHash = "", explorerBase = "") {
  const hash = String(txHash || "").trim();
  const base = String(explorerBase || "").trim();
  if (!hash || !base) return "";
  const encoded = encodeURIComponent(hash);
  if (base.includes("{txHash}")) return base.replace("{txHash}", encoded);
  if (base.includes("{tx}")) return base.replace("{tx}", encoded);
  if (base.includes("{hash}")) return base.replace("{hash}", encoded);
  return `${base.replace(/\/+$/, "")}/transactions/${encoded}`;
}
