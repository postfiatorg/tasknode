// The exact Solana vault deposit transaction. The browser runs this before Phantom opens, and the
// server before it broadcasts: [deposit] alone, or [AdvanceNonce, deposit] with exactly two signers.
import { getProgramDerivedAddress } from "@solana/addresses";
import { getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder } from "@solana/transaction-messages";
import bs58 from "bs58";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const RECENT_BLOCKHASHES = "SysvarRecentB1ockHashes11111111111111111111";

const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
const fromHex = text => Uint8Array.from(text.match(/../g), pair => parseInt(pair, 16));
const pda = async (programAddress, ...seeds) => (await getProgramDerivedAddress({ programAddress, seeds }))[0];
function must(condition, reason) { if (!condition) throw Error("Not the vault deposit: " + reason); }

// bytes: signature count, signature slots, legacy message. expected: program, mint and nonce always;
// owner, amount_atoms, pftl_recipient, nonce_account, nonce_authority, nonce_value and nonceAccounts when known.
// Returns what the transaction commits to. Throws on any difference.
export async function checkDepositShape(bytes, expected) {
  const signers = bytes[0], start = 1 + 64 * signers;
  must([1, 2].includes(signers) && bytes.length > start, "signature count");
  const message = bytes.subarray(start);
  let compiled;
  try { compiled = getCompiledTransactionMessageDecoder().decode(message); } catch { must(false, "unreadable message"); }
  must(compiled.version === "legacy" && hex(getCompiledTransactionMessageEncoder().encode(compiled)) === hex(message), "message encoding");
  const { header, staticAccounts: keys, instructions } = compiled;
  must(header.numSignerAccounts === signers && instructions.length === signers, "signer or instruction count");
  const role = index => {
    const signer = index < header.numSignerAccounts;
    const writable = signer ? index < header.numSignerAccounts - header.numReadonlySignerAccounts
      : index < keys.length - header.numReadonlyNonSignerAccounts;
    return (signer ? "s" : "") + (writable ? "w" : "r");
  };
  const read = ix => {
    const indices = ix.accountIndices ?? [];
    must([ix.programAddressIndex, ...indices].every(index => Number.isInteger(index) && index < keys.length), "account index");
    return { program: keys[ix.programAddressIndex], accounts: indices.map(index => keys[index]), roles: indices.map(role), data: ix.data ?? new Uint8Array() };
  };
  const owner = keys[0];
  must(!expected.owner || owner === expected.owner, "fee payer");
  let durable = null;
  if (signers === 2) {
    const advance = read(instructions[0]);
    const [account, sysvar, authority] = advance.accounts;
    must(advance.program === SYSTEM_PROGRAM && advance.accounts.length === 3 && sysvar === RECENT_BLOCKHASHES &&
      hex(advance.data) === "04000000" && authority === keys[1] && advance.roles.join() === "w,r,sr", "advance nonce");
    must((!expected.nonce_account || account === expected.nonce_account) &&
      (!expected.nonceAccounts || expected.nonceAccounts.includes(account)) &&
      (!expected.nonce_authority || authority === expected.nonce_authority) &&
      (!expected.nonce_value || compiled.lifetimeToken === expected.nonce_value), "nonce account");
    durable = { nonce_account: account, nonce_authority: authority, nonce_value: compiled.lifetimeToken };
  } else {
    must(!expected.nonce_account && !expected.nonce_authority, "missing advance nonce");
  }
  const deposit = read(instructions.at(-1));
  const nonce = fromHex(expected.nonce);
  const [config, custody, receipt] = await Promise.all([pda(expected.program, "config"), pda(expected.program, "custody"), pda(expected.program, "receipt", nonce)]);
  const [payer, source, ...rest] = deposit.accounts;
  must(deposit.program === expected.program && deposit.accounts.length === 8 && new Set(deposit.accounts).size === 8 && payer === owner &&
    rest.join() === [config, custody, expected.mint, receipt, TOKEN_PROGRAM, SYSTEM_PROGRAM].join() &&
    deposit.roles.join() === "sw,w,w,w,r,w,r,r", "deposit accounts");
  const data = deposit.data;
  must(data.length === 61 && data[0] === 1 && hex(data.subarray(29)) === expected.nonce, "deposit data");
  const amount = new DataView(data.buffer, data.byteOffset, data.length).getBigUint64(1, true);
  const recipient = "pf" + hex(data.subarray(9, 29));
  must(amount > 0n && (!expected.amount_atoms || String(amount) === expected.amount_atoms) &&
    (!expected.pftl_recipient || recipient === expected.pftl_recipient), "amount or recipient");
  return { signers, owner, source, amount_atoms: String(amount), pftl_recipient: recipient, durable, signature: bs58.encode(bytes.subarray(1, 65)) };
}
