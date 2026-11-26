// Release reasons cross a trust boundary. Only these fixed diagnostics may reach the relay log.
const reasons = new Set([
  "signature count", "unreadable message", "message encoding", "signer count", "account header",
  "account index", "program role", "Lighthouse instruction", "compute budget", "compute budget cap",
  "unexpected instruction count", "advance nonce must be first", "prepared compute budget",
  "nonce authority signature slot", "fee payer", "advance nonce", "nonce account", "missing advance nonce",
  "deposit accounts", "nonce account or authority outside advance", "additional writable account",
  "source account", "deposit data", "amount or recipient", "partial nonce", "signature slots",
  "missing depositor signature", "invalid Phantom signature", "transaction size", "prepared owner",
  "prepared amount", "prepared recipient", "prepared vault program", "deposit nonce", "validity height", "invalid deposit encoding", "unreadable Phantom reply",
]);
export const refusalText = reason => "Not the vault deposit: " + reason;
export const RELOAD_DEPOSIT = "The wallet has been updated. Reload this page before starting a Solana deposit.";
export const RECONNECT_PHANTOM = "Reconnect Phantom to continue.";
export const knownRefusal = message => typeof message === "string" &&
  (message === RELOAD_DEPOSIT || message === RECONNECT_PHANTOM ||
   (message.startsWith("Not the vault deposit: ") && reasons.has(message.slice("Not the vault deposit: ".length))));
