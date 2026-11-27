// Solana vault deposit transactions for tests, built independently of the server's builder.
import { getProgramDerivedAddress } from '@solana/addresses';
import { AccountRole } from '@solana/instructions';
import { compileTransactionMessage, getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder } from '@solana/transaction-messages';
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
  pdaProgram = program, nonceAccount, authority, lifetime = pub(12), first = [], budget = [], extra = [], signed, sourceRole = WRITABLE }) {
  const seed = Buffer.from(nonce, 'hex');
  const [config, custody, receipt] = await Promise.all([pda(pdaProgram, 'config'), pda(pdaProgram, 'custody'), pda(pdaProgram, 'receipt', seed)]);
  const data = Buffer.alloc(61);
  data[0] = 1;
  data.writeBigUInt64LE(BigInt(amount_atoms), 1);
  Buffer.from(pftl_recipient.slice(2), 'hex').copy(data, 9);
  seed.copy(data, 29);
  const accounts = [[owner, WRITABLE_SIGNER], [source, sourceRole], [config, WRITABLE], [custody, WRITABLE], [mint, READONLY],
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

// Lighthouse assertions as Phantom appends them, laid out as in github.com/Jac0xb/lighthouse
// (programs/lighthouse/src/instruction.rs): a Borsh enum tag, LogLevel (u8, 0 = Silent), then the assertion.
export const LIGHTHOUSE = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
// AssertAccountInfo (5): AccountInfoAssertion::Lamports (0) { value: u64, IntegerOperator::GreaterThanOrEqual (4) }.
export const assertLamports = (target, atLeast, { role = READONLY, programAddress = LIGHTHOUSE } = {}) => {
  const data = Buffer.alloc(12); data[0] = 5; data[2] = 0; data.writeBigUInt64LE(BigInt(atLeast), 3); data[11] = 4;
  return { programAddress, data, accounts: [{ address: target, role }] };
};
// AssertTokenAccountMulti (10): a LEB128 count, then TokenAccountAssertion::Owner (1) { Pubkey, EquatableOperator::Equal (0) }
// and TokenAccountAssertion::Amount (2) { u64, IntegerOperator::GreaterThanOrEqual (4) }.
export const assertTokenAccount = (target, owner, atLeast, { role = READONLY, programAddress = LIGHTHOUSE } = {}) => {
  const amount = Buffer.alloc(8); amount.writeBigUInt64LE(BigInt(atLeast));
  const data = Buffer.concat([Buffer.from([10, 0, 2, 1]), Buffer.from(bs58.decode(owner)), Buffer.from([0, 2]), amount, Buffer.from([4])]);
  return { programAddress, data, accounts: [{ address: target, role }] };
};

// A System transfer from the owner, for "no other instruction" cases.
export const transfer = (from, to) => ({ programAddress: SYSTEM, data: Buffer.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
  accounts: [{ address: from, role: WRITABLE_SIGNER }, { address: to, role: WRITABLE }] });

// Re-encode the message of signed bytes after `edit`, keeping every signature slot as it was.
export function recompile(bytes, edit) {
  const start = 1 + 64 * bytes[0];
  const compiled = getCompiledTransactionMessageDecoder().decode(bytes.subarray(start));
  return Buffer.concat([bytes.subarray(0, start), Buffer.from(getCompiledTransactionMessageEncoder().encode(edit(compiled)))]);
}
