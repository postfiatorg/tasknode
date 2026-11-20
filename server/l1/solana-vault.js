// Vault ABI: pfusdc-vault/src/lib.rs, deposit tag 1, classic SPL Token.
import { randomBytes } from 'node:crypto';
import { address, getProgramDerivedAddress } from '@solana/addresses';
import { AccountRole } from '@solana/instructions';
import { compileTransactionMessage, getCompiledTransactionMessageEncoder } from '@solana/transaction-messages';
import bs58 from 'bs58';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SYSTEM = '11111111111111111111111111111111';
const pda = async (programAddress, ...seeds) => (await getProgramDerivedAddress({ programAddress, seeds }))[0];

function solanaRpc(url) {
  async function call(method, params) {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const reply = await response.json();
    if (!response.ok || reply.id !== 1 || reply.error || !('result' in reply)) throw Error('Solana RPC unavailable');
    return reply.result;
  }
  return {
    getAccountInfo: async (key, options) => {
      const { value } = await call('getAccountInfo', [key, { commitment: 'finalized', encoding: 'base64', ...options }]);
      if (!value) return null;
      if (value.data?.[1] !== 'base64') throw Error('Invalid Solana account encoding');
      return { owner: value.owner, data: Buffer.from(value.data[0], 'base64') };
    },
    getEpochInfo: () => call('getEpochInfo', [{ commitment: 'finalized' }]),
    getLatestBlockhash: async () => (await call('getLatestBlockhash', [{ commitment: 'confirmed' }])).value,
    getTokenAccounts: (owner, mint) => call('getTokenAccountsByOwner', [owner, { mint }, { commitment: 'confirmed', encoding: 'jsonParsed' }]),
    getSignaturesForAddress: (receipt, options) => call('getSignaturesForAddress', [receipt, { commitment: 'finalized', ...options }]),
    getParsedTransaction: signature => call('getTransaction', [signature, { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]),
  };
}

export class DepositError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function vaultSettings(env) {
  if (!env.L1_SOLANA_RPC_URL || !env.L1_SOLANA_VAULT_PROGRAM_ID || !/^[0-9a-f]{64}$/.test(env.L1_SOLANA_ROUTE_BINDING || '')) {
    throw new DepositError(503, 'The Solana vault is awaiting configuration.');
  }
  return {
    program: address(env.L1_SOLANA_VAULT_PROGRAM_ID), mint: address(env.L1_SOLANA_USDC_MINT || USDC),
    binding: env.L1_SOLANA_ROUTE_BINDING, rpc: solanaRpc(env.L1_SOLANA_RPC_URL),
  };
}

export async function readVault({ rpc, program, mint, binding }, relay) {
  const config = await pda(program, 'config');
  const [info, epoch] = await Promise.all([rpc.getAccountInfo(config), rpc.getEpochInfo()]);
  if (relay.ready !== true || relay.vault_program_id !== program ||
      !Number.isSafeInteger(relay.light_client_epoch) || relay.light_client_epoch !== epoch.epoch ||
      info?.owner !== program || info.data.length !== 96 || !info.data.subarray(0, 32).equals(bs58.decode(mint)) ||
      info.data.subarray(32, 64).toString('hex') !== binding) {
    throw new DepositError(503, 'The vault configuration or light-client epoch does not match the active Solana route.');
  }
  const cap = info.data.readBigUInt64LE(64), total = info.data.readBigUInt64LE(72), used = info.data.readBigUInt64LE(80);
  const remaining = total - used;
  if (!cap || cap > total || remaining <= 0n || BigInt(epoch.absoluteSlot) <= info.data.readBigUInt64LE(88)) {
    throw new DepositError(503, 'The Solana vault cannot accept another deposit.');
  }
  return { ok: true, ready: true, vault_program_id: program, mint: mint, route_binding: binding,
    light_client_epoch: epoch.epoch, per_deposit_cap_atoms: String(cap), total_cap_atoms: String(total),
    available_atoms: String(remaining < cap ? remaining : cap) };
}

export async function buildVaultDeposit({ rpc, program, mint }, ready, request) {
  const amount = BigInt(request.amount_atoms), owner = address(request.owner);
  if (amount > BigInt(ready.available_atoms)) throw new DepositError(409, 'The amount exceeds the current vault cap.');
  const [tokenAccounts, block] = await Promise.all([
    rpc.getTokenAccounts(owner, mint), rpc.getLatestBlockhash(),
  ]);
  const source = tokenAccounts.value.find(({ account }) => {
    const info = account.data.parsed?.info;
    return account.owner === TOKEN && info?.state === 'initialized' && info.owner === request.owner &&
      info.mint === mint && info.tokenAmount.decimals === 6 && BigInt(info.tokenAmount.amount) >= amount;
  });
  if (!source) throw new DepositError(409, 'No USDC account in Phantom has enough available for this deposit.');
  const nonce = randomBytes(32);
  const [config, custody, receipt] = await Promise.all([pda(program, 'config'), pda(program, 'custody'), pda(program, 'receipt', nonce)]);
  const data = Buffer.alloc(61);
  data[0] = 1;
  data.writeBigUInt64LE(amount, 1);
  Buffer.from(request.pftl_recipient.slice(2), 'hex').copy(data, 9);
  nonce.copy(data, 29);
  const { WRITABLE_SIGNER, WRITABLE, READONLY } = AccountRole;
  const accounts = [[owner, WRITABLE_SIGNER], [source.pubkey, WRITABLE], [config, WRITABLE], [custody, WRITABLE],
    [mint, READONLY], [receipt, WRITABLE], [TOKEN, READONLY], [SYSTEM, READONLY]].map(([address, role]) => ({ address, role }));
  const message = compileTransactionMessage({ version: 'legacy', feePayer: { address: owner },
    lifetimeConstraint: { blockhash: block.blockhash, lastValidBlockHeight: BigInt(block.lastValidBlockHeight) },
    instructions: [{ programAddress: program, accounts, data }] });
  // Phantom's request API deserializes this as a whole transaction: a signature count, one
  // empty slot for the depositor's signature, then the message. A bare message is misparsed.
  const compiled = Buffer.from(getCompiledTransactionMessageEncoder().encode(message));
  const unsigned = bs58.encode(Buffer.concat([Buffer.from([1]), Buffer.alloc(64), compiled]));
  return { ok: true, ...request, vault_program_id: program, receipt,
    nonce: nonce.toString('hex'), last_valid_block_height: block.lastValidBlockHeight, message_b58: unsigned };
}

// Phantom may have broadcast before its reply reached the tab. Only the vault can create
// this permanent receipt. Read a finalized bank after blockhash expiry before releasing the form.
export async function recoverDeposit({ rpc, program }, { nonce, last_valid_block_height: lastHeight, vault_program_id: expected, before }) {
  if (program !== expected) throw new DepositError(409, 'This deposit belongs to a different vault configuration.');
  const receipt = await pda(program, 'receipt', Buffer.from(nonce, 'hex'));
  const epoch = await rpc.getEpochInfo();
  const account = await rpc.getAccountInfo(receipt, { commitment: 'finalized', minContextSlot: epoch.absoluteSlot });
  if (!account) return { ok: true, expired: epoch.blockHeight > lastHeight };
  if (account.owner !== program || account.data.length !== 132 || account.data.toString('ascii', 0, 8) !== 'PFSOLRC1' ||
      account.data.toString('hex', 68, 100) !== nonce) {
    return { ok: true, expired: epoch.blockHeight > lastHeight };
  }
  // Ignore unrelated references to the PDA. Look for the successful deposit instruction.
  const signatures = await rpc.getSignaturesForAddress(receipt, { limit: 8, before });
  for (const { signature, err } of signatures) {
    if (err) continue;
    const tx = await rpc.getParsedTransaction(signature);
    if (tx?.meta && !tx.meta.err && tx.transaction.message.instructions.some(ix => {
      if (ix.programId !== program || ix.accounts?.[5] !== receipt) return false;
      const data = Buffer.from(bs58.decode(ix.data));
      return data.length === 61 && data[0] === 1 && data.toString('hex', 29) === nonce;
    })) return { ok: true, signature };
  }
  return { ok: true, expired: false, ...(signatures.length === 8 && { before: signatures.at(-1).signature }) };
}
