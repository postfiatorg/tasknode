// Solana vault deposit transactions for tests, built independently of the server's builder.
import { getProgramDerivedAddress } from '@solana/addresses';
import { AccountRole } from '@solana/instructions';
import { compileTransactionMessage, getCompiledTransactionMessageEncoder } from '@solana/transaction-messages';
import bs58 from 'bs58';

export const pub = byte => bs58.encode(Buffer.alloc(32, byte));
export const SYSTEM = '11111111111111111111111111111111';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const RECENT_BLOCKHASHES = 'SysvarRecentB1ockHashes11111111111111111111';
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const { WRITABLE_SIGNER, READONLY_SIGNER, WRITABLE, READONLY } = AccountRole;
const pda = async (programAddress, ...seeds) => (await getProgramDerivedAddress({ programAddress, seeds }))[0];

// Compute-budget instructions as a wallet writes them: SetComputeUnitLimit (2, u32) and SetComputeUnitPrice (3, u64).
export const unitLimit = (units, accounts) => {
  const data = Buffer.alloc(5); data[0] = 2; data.writeUInt32LE(units, 1);
  return { programAddress: COMPUTE_BUDGET, data, ...(accounts && { accounts }) };
};
export const unitPrice = (microLamports, accounts) => {
  const data = Buffer.alloc(9); data[0] = 3; data.writeBigUInt64LE(BigInt(microLamports), 1);
  return { programAddress: COMPUTE_BUDGET, data, ...(accounts && { accounts }) };
};

// Signature count, signature slots (zero, or filled with `signed`), then the legacy message:
// [...first, AdvanceNonce?, ...budget, deposit, ...extra].
export async function solanaDeposit({ program, mint, owner, source, nonce, amount_atoms, pftl_recipient, feePayer = owner,
  pdaProgram = program, nonceAccount, authority, lifetime = pub(12), first = [], budget = [], extra = [], signed }) {
  const seed = Buffer.from(nonce, 'hex');
  const [config, custody, receipt] = await Promise.all([pda(pdaProgram, 'config'), pda(pdaProgram, 'custody'), pda(pdaProgram, 'receipt', seed)]);
  const data = Buffer.alloc(61);
  data[0] = 1;
  data.writeBigUInt64LE(BigInt(amount_atoms), 1);
  Buffer.from(pftl_recipient.slice(2), 'hex').copy(data, 9);
  seed.copy(data, 29);
  const accounts = [[owner, WRITABLE_SIGNER], [source, WRITABLE], [config, WRITABLE], [custody, WRITABLE], [mint, READONLY],
    [receipt, WRITABLE], [TOKEN, READONLY], [SYSTEM, READONLY]].map(([address, role]) => ({ address, role }));
  const advance = nonceAccount && { programAddress: SYSTEM, data: Buffer.from([4, 0, 0, 0]), accounts: [
    { address: nonceAccount, role: WRITABLE }, { address: RECENT_BLOCKHASHES, role: READONLY }, { address: authority, role: READONLY_SIGNER }] };
  const message = compileTransactionMessage({ version: 'legacy', feePayer: { address: feePayer },
    lifetimeConstraint: { blockhash: lifetime, lastValidBlockHeight: 1n },
    instructions: [...first, ...(advance ? [advance] : []), ...budget, { programAddress: program, accounts, data }, ...extra] });
  const signers = message.header.numSignerAccounts;
  const slots = Buffer.alloc(64 * signers);
  if (signed) slots.fill(signed);
  return Buffer.concat([Buffer.from([signers]), slots, Buffer.from(getCompiledTransactionMessageEncoder().encode(message))]);
}

// A System transfer from the owner, for "no other instruction" cases.
export const transfer = (from, to) => ({ programAddress: SYSTEM, data: Buffer.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
  accounts: [{ address: from, role: WRITABLE_SIGNER }, { address: to, role: WRITABLE }] });
