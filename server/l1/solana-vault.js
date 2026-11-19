// Vault ABI: pfusdc-vault/src/lib.rs, deposit tag 1, classic SPL Token.
import { randomBytes } from 'node:crypto';
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(s => Buffer.from(s)), program)[0];

export class DepositError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function vaultSettings(env) {
  if (!env.L1_SOLANA_RPC_URL || !env.L1_SOLANA_VAULT_PROGRAM_ID || !/^[0-9a-f]{64}$/.test(env.L1_SOLANA_ROUTE_BINDING || '')) {
    throw new DepositError(503, 'The Solana vault is awaiting configuration.');
  }
  return {
    program: new PublicKey(env.L1_SOLANA_VAULT_PROGRAM_ID),
    mint: new PublicKey(env.L1_SOLANA_USDC_MINT || USDC),
    binding: env.L1_SOLANA_ROUTE_BINDING,
    rpc: new Connection(env.L1_SOLANA_RPC_URL, { commitment: 'finalized', disableRetryOnRateLimit: true,
      fetch: (url, options) => fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) }) }),
  };
}

export async function readVault({ rpc, program, mint, binding }, relay) {
  const config = pda(program, 'config');
  const [info, epoch] = await Promise.all([rpc.getAccountInfo(config), rpc.getEpochInfo()]);
  if (relay.ready !== true || relay.vault_program_id !== program.toBase58() ||
      !Number.isSafeInteger(relay.light_client_epoch) || relay.light_client_epoch !== epoch.epoch ||
      !info?.owner.equals(program) || info.data.length !== 96 || !info.data.subarray(0, 32).equals(mint.toBuffer()) ||
      info.data.subarray(32, 64).toString('hex') !== binding) {
    throw new DepositError(503, 'The vault configuration or light-client epoch does not match the active Solana route.');
  }
  const cap = info.data.readBigUInt64LE(64), total = info.data.readBigUInt64LE(72), used = info.data.readBigUInt64LE(80);
  const remaining = total - used;
  if (!cap || cap > total || remaining <= 0n || BigInt(epoch.absoluteSlot) <= info.data.readBigUInt64LE(88)) {
    throw new DepositError(503, 'The Solana vault cannot accept another deposit.');
  }
  return { ok: true, ready: true, vault_program_id: program.toBase58(), mint: mint.toBase58(), route_binding: binding,
    light_client_epoch: epoch.epoch, per_deposit_cap_atoms: String(cap), total_cap_atoms: String(total),
    available_atoms: String(remaining < cap ? remaining : cap) };
}

export async function buildVaultDeposit({ rpc, program, mint }, ready, request) {
  const amount = BigInt(request.amount_atoms), owner = new PublicKey(request.owner);
  if (amount > BigInt(ready.available_atoms)) throw new DepositError(409, 'The amount exceeds the current vault cap.');
  const [accounts, block] = await Promise.all([
    rpc.getParsedTokenAccountsByOwner(owner, { mint }, 'confirmed'), rpc.getLatestBlockhash('confirmed'),
  ]);
  const source = accounts.value.find(({ account }) => {
    const info = account.data.parsed?.info;
    return account.owner.equals(TOKEN) && info?.state === 'initialized' && info.owner === request.owner &&
      info.mint === mint.toBase58() && info.tokenAmount.decimals === 6 && BigInt(info.tokenAmount.amount) >= amount;
  });
  if (!source) throw new DepositError(409, 'No USDC account in Phantom has enough available for this deposit.');
  const nonce = randomBytes(32), receipt = pda(program, 'receipt', nonce);
  const data = Buffer.alloc(61);
  data[0] = 1;
  data.writeBigUInt64LE(amount, 1);
  Buffer.from(request.pftl_recipient.slice(2), 'hex').copy(data, 9);
  nonce.copy(data, 29);
  const accountsInOrder = [owner, source.pubkey, pda(program, 'config'), pda(program, 'custody'), mint, receipt, TOKEN, SystemProgram.programId];
  const instruction = new TransactionInstruction({ programId: program, data,
    keys: accountsInOrder.map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: [0, 1, 2, 3, 5].includes(i) })) });
  const transaction = new Transaction({ feePayer: owner, recentBlockhash: block.blockhash }).add(instruction);
  return { ok: true, ...request, vault_program_id: program.toBase58(), receipt: receipt.toBase58(),
    nonce: nonce.toString('hex'), last_valid_block_height: block.lastValidBlockHeight, message_b58: bs58.encode(transaction.serializeMessage()) };
}

// Phantom may have broadcast before its reply reached the tab. Only the vault can create
// this permanent receipt. Read a finalized bank after blockhash expiry before releasing the form.
export async function recoverDeposit({ rpc, program }, { nonce, last_valid_block_height: lastHeight }) {
  const receipt = pda(program, 'receipt', Buffer.from(nonce, 'hex'));
  const epoch = await rpc.getEpochInfo('finalized');
  const account = await rpc.getAccountInfo(receipt, { commitment: 'finalized', minContextSlot: epoch.absoluteSlot });
  if (!account) return { ok: true, expired: epoch.blockHeight > lastHeight };
  if (!account.owner.equals(program) || account.data.length !== 132 || account.data.toString('ascii', 0, 8) !== 'PFSOLRC1' ||
      account.data.toString('hex', 68, 100) !== nonce) {
    return { ok: true, expired: epoch.blockHeight > lastHeight };
  }
  // Ignore unrelated references to the PDA. Look for the successful deposit instruction.
  const signatures = await rpc.getSignaturesForAddress(receipt, { limit: 8 }, 'finalized');
  for (const { signature, err } of signatures) {
    if (err) continue;
    const tx = await rpc.getParsedTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (tx?.meta && !tx.meta.err && tx.transaction.message.instructions.some(ix => {
      if (!ix.programId.equals(program) || !ix.accounts?.[5]?.equals(receipt)) return false;
      const data = Buffer.from(bs58.decode(ix.data));
      return data.length === 61 && data[0] === 1 && data.toString('hex', 29) === nonce;
    })) return { ok: true, signature };
  }
  return { ok: true, expired: false };
}
