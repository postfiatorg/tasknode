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
