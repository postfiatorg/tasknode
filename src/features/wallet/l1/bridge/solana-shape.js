import { getProgramDerivedAddress } from "@solana/addresses";
import { getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder } from "@solana/transaction-messages";
import { refusalText } from "./solana-refusal.js";
import bs58 from "bs58";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const RECENT_BLOCKHASHES = "SysvarRecentB1ockHashes11111111111111111111";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
// Caps for a wallet-supplied compute budget.
export const MAX_COMPUTE_UNIT_LIMIT = 400_000;
export const MAX_COMPUTE_UNIT_PRICE = 2_000_000;
// Instruction tag -> [name, data length, cap]. No other compute-budget instruction is accepted.
const BUDGET = { 2: ["limit", 5, MAX_COMPUTE_UNIT_LIMIT], 3: ["price", 9, MAX_COMPUTE_UNIT_PRICE] };

const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
const fromHex = text => Uint8Array.from(text.match(/../g), pair => parseInt(pair, 16));
const pda = async (programAddress, ...seeds) => (await getProgramDerivedAddress({ programAddress, seeds }))[0];
function must(condition, reason) { if (!condition) throw Error(refusalText(reason)); }

// Only public instruction metadata goes to the browser console, never the signed wire transaction.
export function instructionLayout(bytes) {
  try {
    const { header, staticAccounts, instructions } = getCompiledTransactionMessageDecoder().decode(bytes.subarray(1 + 64 * bytes[0]));
    return { header, staticAccounts, instructions: instructions.map(ix => ({ program: staticAccounts[ix.programAddressIndex],
      accounts: Array.from(ix.accountIndices ?? [], i => staticAccounts[i]), tag: ix.data?.[0], dataLength: ix.data?.length ?? 0 })) };
  } catch { return { unreadable: true }; }
}

// Both the browser and the co-signer decode the actual signed legacy message. Instructions are
// compared by address and privilege because adding a read-only key can renumber compiled indices.
export async function checkDepositShape(bytes, expected, { signed = false } = {}) {
  const signers = bytes[0], start = 1 + 64 * signers;
  must([1, 2].includes(signers) && bytes.length > start, "signature count");
  must(bytes.length <= 1232, "transaction size");
  const message = bytes.subarray(start);
  let compiled;
  try { compiled = getCompiledTransactionMessageDecoder().decode(message); } catch { must(false, "unreadable message"); }
  must(compiled.version === "legacy" && hex(getCompiledTransactionMessageEncoder().encode(compiled)) === hex(message), "message encoding");
  const { header, staticAccounts: keys, instructions } = compiled;
  must(header.numSignerAccounts === signers, "signer count");
  must(new Set(keys).size === keys.length && keys.length >= signers &&
    header.numReadonlyNonSignerAccounts <= keys.length - signers && header.numReadonlySignerAccounts < signers, "account header");
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
  const budget = {}, layout = [], others = [], assertions = [];
  for (const ix of instructions) {
    const { program, accounts, data } = read(ix);
    // Every program is invoked read-only, as compiled; no instruction can make one writable or a signer.
    must(role(ix.programAddressIndex) === "r", "program role");
    if (program === LIGHTHOUSE_PROGRAM && signed) {
      // LighthouseInstruction (Jac0xb/lighthouse): 0/1 write or close memory. Only the known
      // assertion variants (2..17) test state and abort on a mismatch.
      must(data[0] >= 2 && data[0] <= 17, "Lighthouse instruction");
      assertions.push(...accounts);
      continue;
    }
    if (program !== COMPUTE_BUDGET_PROGRAM) { others.push(ix); layout.push("other"); continue; }
    const [name, size, cap] = BUDGET[data[0]] ?? [];
    must(name && !(name in budget) && !accounts.length && data.length === size, "compute budget");
    const view = new DataView(data.buffer, data.byteOffset, data.length);
    budget[name] = size === 5 ? view.getUint32(1, true) : view.getBigUint64(1, true);
    must(budget[name] <= cap, "compute budget cap");
    layout.push(name);
  }
  must(others.length === signers, "unexpected instruction count");
  if (signers === 2) {
    must(instructions[0] === others[0], "advance nonce must be first");
    // Solana charges the requested price against the default limit when no limit is supplied.
    // Multiple guard instructions can raise that default above 400k. Preserve the maximum
    // priority fee (800,000 lamports) even when Phantom removes the explicit limit.
    if (budget.limit === undefined && budget.price > 0n) {
      const defaultUnits = instructions.reduce((sum, ix) => {
        const program = keys[ix.programAddressIndex];
        return sum + (program === SYSTEM_PROGRAM || program === COMPUTE_BUDGET_PROGRAM ? 3_000 : 200_000);
      }, 0);
      must(BigInt(Math.min(1_400_000, defaultUnits)) * budget.price <= BigInt(MAX_COMPUTE_UNIT_LIMIT * MAX_COMPUTE_UNIT_PRICE), "compute budget cap");
    }
    if (!signed) must(layout.join() === "other,limit,price,other", "prepared compute budget");
    if (signed) must(bytes.subarray(65, 129).every(byte => byte === 0), "nonce authority signature slot");
  }
  const owner = keys[0];
  must(!expected.owner || owner === expected.owner, "fee payer");
  let durable = null;
  if (signers === 2) {
    const advance = read(others[0]);
    const [account, sysvar, authority] = advance.accounts;
    must(advance.program === SYSTEM_PROGRAM && advance.accounts.length === 3 && sysvar === RECENT_BLOCKHASHES &&
      hex(advance.data) === "04000000" && authority === keys[1] && advance.roles.join() === "w,r,sr", "advance nonce");
    must((!expected.nonce_account || account === expected.nonce_account) &&
      (!expected.nonce_authority || authority === expected.nonce_authority) &&
      (!expected.nonce_value || compiled.lifetimeToken === expected.nonce_value), "nonce account");
    durable = { nonce_account: account, nonce_authority: authority, nonce_value: compiled.lifetimeToken };
  } else {
    must(!expected.nonce_account && !expected.nonce_authority, "missing advance nonce");
  }
  const deposit = read(others.at(-1));
  const nonce = fromHex(expected.nonce);
  const [config, custody, receipt] = await Promise.all([pda(expected.program, "config"), pda(expected.program, "custody"), pda(expected.program, "receipt", nonce)]);
  const [payer, source, ...rest] = deposit.accounts;
  must(deposit.program === expected.program && deposit.accounts.length === 8 && new Set(deposit.accounts).size === 8 && payer === owner &&
    rest.join() === [config, custody, expected.mint, receipt, TOKEN_PROGRAM, SYSTEM_PROGRAM].join() &&
    deposit.roles.join() === "sw,w,w,w,r,w,r,r", "deposit accounts");
  if (durable) {
    // The authority is read-only and only AdvanceNonce receives its signer privilege. The depositor
    // pays the fee and authorizes the original vault action. Extra instructions can only set a
    // bounded budget or assert state. Even unused keys cannot enlarge the writable set. The advance
    // changes the nonce account, so Phantom may assert on it: assertions (tags 2..17) only read,
    // and only the System program can change that System-owned account. The deposit may name
    // neither nonce key, and no assertion the authority, whose signer privilege it would receive.
    const { nonce_account: account, nonce_authority: authority } = durable;
    must(!deposit.accounts.some(key => key === account || key === authority) && !assertions.includes(authority),
      "nonce account or authority outside advance");
    const writable = new Set([owner, source, config, custody, receipt, durable.nonce_account]);
    must(keys.every((key, i) => !role(i).endsWith("w") || writable.has(key)), "additional writable account");
  }
  must(!expected.source || source === expected.source, "source account");
  const data = deposit.data;
  must(data.length === 61 && data[0] === 1 && hex(data.subarray(29)) === expected.nonce, "deposit data");
  const amount = new DataView(data.buffer, data.byteOffset, data.length).getBigUint64(1, true);
  const recipient = "pf" + hex(data.subarray(9, 29));
  must(amount > 0n && (!expected.amount_atoms || String(amount) === expected.amount_atoms) &&
    (!expected.pftl_recipient || recipient === expected.pftl_recipient), "amount or recipient");
  return { signers, owner, source, amount_atoms: String(amount), pftl_recipient: recipient, durable, budget, message,
    signature: bs58.encode(bytes.subarray(1, 65)) };
}
