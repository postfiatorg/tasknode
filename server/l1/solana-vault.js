// Vault ABI: pfusdc-vault/src/lib.rs, deposit tag 1, classic SPL Token.
import { createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { address, getProgramDerivedAddress } from '@solana/addresses';
import { AccountRole } from '@solana/instructions';
import { compileTransactionMessage, getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder } from '@solana/transaction-messages';
import bs58 from 'bs58';
import { checkDepositShape } from '../../src/features/wallet/l1/bridge/solana-shape.js';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SYSTEM = '11111111111111111111111111111111';
const RECENT_BLOCKHASHES = 'SysvarRecentB1ockHashes11111111111111111111';
// A depositor may hold a nonce for this long before it is offered to someone else.
const NONCE_LEASE_MS = 11 * 60 * 1000;
// At most this many signed deposits are re-sent in the background at once; the rest are sent once.
export const MAX_RESEND_LOOPS = 16;
// Nonce account -> { value, until, holder, intent }. A holder is one signed-in account.
const leases = new Map();
let leasing = Promise.resolve(), resending = 0, authorityWarned = false;
const pda = async (programAddress, ...seeds) => (await getProgramDerivedAddress({ programAddress, seeds }))[0];

function solanaRpc(url) {
  async function call(method, params) {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const reply = await response.json();
    if (reply?.error && method === 'sendTransaction') throw new DepositError(409, 'Solana rejected the deposit: ' + String(reply.error.message).slice(0, 200));
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
    sendTransaction: (base64, options) => call('sendTransaction', [base64, { encoding: 'base64', ...options }]),
    getSignatureStatus: async signature => (await call('getSignatureStatuses', [[signature]])).value[0],
    getParsedTransaction: signature => call('getTransaction', [signature, { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]),
  };
}

export class DepositError extends Error {
  constructor(status, message, code = 'solana_bridge_unavailable') { super(message); this.status = status; this.code = code; }
}

export function vaultSettings(env) {
  if (!env.L1_SOLANA_RPC_URL || !env.L1_SOLANA_VAULT_PROGRAM_ID || !/^[0-9a-f]{64}$/.test(env.L1_SOLANA_ROUTE_BINDING || '')) {
    throw new DepositError(503, 'The Solana vault is awaiting configuration.');
  }
  return {
    program: address(env.L1_SOLANA_VAULT_PROGRAM_ID), mint: address(env.L1_SOLANA_USDC_MINT || USDC),
    binding: env.L1_SOLANA_ROUTE_BINDING, rpc: solanaRpc(env.L1_SOLANA_RPC_URL),
    nonceFile: env.L1_SOLANA_NONCE_FILE, nonceKey: env.L1_SOLANA_NONCE_AUTHORITY_KEY,
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

// The nonce file and the authority key, or null. The key must be the file's authority: a deposit
// co-signed by another key fails preflight, so use a recent blockhash instead.
async function nonceSigner({ nonceFile, nonceKey }) {
  if (!nonceFile || !nonceKey) return null;
  let problem;
  try {
    const { authority, accounts } = JSON.parse(await readFile(nonceFile, 'utf8'));
    const seed = Buffer.from(JSON.parse(await readFile(nonceKey, 'utf8'))).subarray(0, 32);
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    if (bs58.encode(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32)) === authority && Array.isArray(accounts)) {
      return { authority: address(authority), accounts, key };
    }
    problem = 'Solana nonce authority key does not match the nonce file authority';
  } catch { problem = 'Solana nonce file or authority key is unreadable'; }
  if (!authorityWarned) console.warn(problem + '; deposits use a recent blockhash.');
  authorityWarned = true;
  return null;
}

// Nonce account data: version u32, state u32 (1 = initialized), authority, nonce value, fee.
async function nonceValue(rpc, account, authority, options) {
  const info = await rpc.getAccountInfo(account, options);
  if (info?.owner !== SYSTEM || info.data.length !== 80 || info.data.readUInt32LE(4) !== 1 ||
      (authority && bs58.encode(info.data.subarray(8, 40)) !== authority)) return null;
  return bs58.encode(info.data.subarray(40, 72));
}

const held = ({ nonce_account: account, nonce_value: value }) => {
  const lease = leases.get(account);
  return lease?.value === value && lease.until > Date.now();
};

// A transaction on a recent blockhash is valid for 150 blocks, about half a minute, which is
// less than a careful approval in Phantom takes. A durable nonce keeps it valid until used.
// Returns a free nonce account, or null when all are out. A holder keeps at most one lease.
function leaseNonce({ rpc }, signer, holder, intent) {
  const turn = leasing.then(async () => {
    if (holder) for (const [account, lease] of leases) if (lease.holder === holder) leases.delete(account);
    for (const account of signer.accounts) {
      const value = await nonceValue(rpc, account, signer.authority, { commitment: 'confirmed' });
      if (!value || held({ nonce_account: account, nonce_value: value })) continue;
      leases.set(account, { value, until: Date.now() + NONCE_LEASE_MS, holder, intent });
      return { account: address(account), value };
    }
    return null;
  });
  leasing = turn.catch(() => null);
  return turn.catch(() => null);
}

// The depositor declined in Phantom, or the browser refused the prepared transaction.
export function releaseDeposit(holder, intent) {
  for (const [account, lease] of leases) {
    if (holder && lease.holder === holder && lease.intent === intent) { leases.delete(account); return { ok: true, released: true }; }
  }
  return { ok: true, released: false };
}

export async function buildVaultDeposit(settings, ready, request, holder) {
  const { rpc, program, mint } = settings;
  const amount = BigInt(request.amount_atoms), owner = address(request.owner);
  if (amount > BigInt(ready.available_atoms)) throw new DepositError(409, 'The amount exceeds the current vault cap.');
  const tokenAccounts = await rpc.getTokenAccounts(owner, mint);
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
  const { WRITABLE_SIGNER, READONLY_SIGNER, WRITABLE, READONLY } = AccountRole;
  const accounts = [[owner, WRITABLE_SIGNER], [source.pubkey, WRITABLE], [config, WRITABLE], [custody, WRITABLE],
    [mint, READONLY], [receipt, WRITABLE], [TOKEN, READONLY], [SYSTEM, READONLY]].map(([address, role]) => ({ address, role }));
  const deposit = { programAddress: program, accounts, data };
  // Lease only after the cheap checks. Any failure from here on gives the lease back.
  const signer = await nonceSigner(settings);
  const durable = signer && signer.authority !== owner && await leaseNonce(settings, signer, holder, nonce.toString('hex'));
  try {
    const block = await rpc.getLatestBlockhash();
    // System AdvanceNonceAccount (4) must come first, signed by the nonce authority.
    const advance = durable && { programAddress: address(SYSTEM), data: Buffer.from([4, 0, 0, 0]), accounts: [
      { address: durable.account, role: WRITABLE }, { address: address(RECENT_BLOCKHASHES), role: READONLY },
      { address: signer.authority, role: READONLY_SIGNER }] };
    const message = compileTransactionMessage({ version: 'legacy', feePayer: { address: owner },
      lifetimeConstraint: { blockhash: durable ? durable.value : block.blockhash, lastValidBlockHeight: BigInt(block.lastValidBlockHeight) },
      instructions: durable ? [advance, deposit] : [deposit] });
    // Phantom's request API deserializes this as a whole transaction: a signature count, an
    // empty slot for the depositor's signature, then the message. A bare message is misparsed.
    const compiled = Buffer.from(getCompiledTransactionMessageEncoder().encode(message));
    const slots = [Buffer.alloc(64)];
    if (durable) {
      if (getCompiledTransactionMessageDecoder().decode(compiled).staticAccounts[1] !== signer.authority) throw Error('unexpected signer order');
      slots.push(sign(null, compiled, signer.key));
    }
    const unsigned = bs58.encode(Buffer.concat([Buffer.from([slots.length]), ...slots, compiled]));
    // Without a nonce the card stops waiting at this height. With one, recovery reads the nonce instead.
    const deadline = block.lastValidBlockHeight + (durable ? 2650 : 0);
    return { ok: true, ...request, vault_program_id: program, receipt,
      nonce: nonce.toString('hex'), last_valid_block_height: deadline, message_b58: unsigned,
      ...(durable && { nonce_account: durable.account, nonce_authority: signer.authority, nonce_value: durable.value }) };
  } catch (error) {
    if (durable) releaseDeposit(holder, nonce.toString('hex'));
    throw error;
  }
}

// Broadcast the transaction the depositor signed in Phantom, if it is exactly this vault's deposit.
// A blockhash transaction is valid for about half a minute: re-send until a bank reports it. A
// durable-nonce one stays valid until its nonce moves: re-send while the lease is held and it has not.
export async function sendDeposit(settings, { transaction_b64: encoded, nonce }, resend = { every: 2000, times: 14 }) {
  const { rpc, program, mint } = settings;
  const bytes = Buffer.from(encoded, 'base64');
  // One signature (the depositor) or two (the depositor, then the nonce authority).
  const signers = bytes[0], start = 1 + 64 * signers;
  if (![1, 2].includes(signers) || bytes.length <= start || bytes.length > 1232 || bytes.subarray(1, 65).every(b => b === 0)) {
    throw new DepositError(400, 'Phantom did not return a signed deposit.');
  }
  const pool = signers === 2 && settings.nonceFile ? JSON.parse(await readFile(settings.nonceFile, 'utf8')) : null;
  let shape;
  try {
    if (signers === 2 && !pool) throw Error('no nonce file');
    shape = await checkDepositShape(bytes, { program, mint, nonce, ...(pool && { nonce_authority: pool.authority, nonceAccounts: pool.accounts }) });
  } catch { throw new DepositError(400, 'The signed transaction is not this vault deposit.'); }
  const { signature, durable } = shape;
  await rpc.sendTransaction(encoded, { preflightCommitment: 'confirmed', maxRetries: 3 });
  if (resending >= MAX_RESEND_LOOPS) return { ok: true, signature };
  resending++;
  (async () => {
    for (let i = 0; durable || i < resend.times; i++) {
      await new Promise(resolve => setTimeout(resolve, resend.every));
      try {
        if (await rpc.getSignatureStatus(signature)) return;
        if (durable && !(held(durable) && await nonceValue(rpc, durable.nonce_account, durable.nonce_authority, { commitment: 'confirmed' }) === durable.nonce_value)) return;
        await rpc.sendTransaction(encoded, { skipPreflight: true, maxRetries: 0 });
      } catch {
        // Expiry ends a blockhash loop; recovery reads the vault. A durable loop ends with its lease.
        if (durable && !held(durable)) return;
      }
    }
  })().finally(() => { resending--; });
  return { ok: true, signature };
}

// Phantom may have broadcast before its reply reached the tab. Only the vault can create
// this permanent receipt. Read a finalized bank after expiry before releasing the form. A
// durable-nonce deposit expires only once its nonce has moved past the signed value: read the
// nonce first, so a deposit that lands between the two reads is seen by the receipt read.
export async function recoverDeposit({ rpc, program }, { nonce, last_valid_block_height: lastHeight, vault_program_id: expected, before,
  nonce_account: nonceAccount, nonce_value: signedValue }) {
  if (program !== expected) throw new DepositError(409, 'This deposit belongs to a different vault configuration.');
  const receipt = await pda(program, 'receipt', Buffer.from(nonce, 'hex'));
  const epoch = await rpc.getEpochInfo();
  const finalized = { commitment: 'finalized', minContextSlot: epoch.absoluteSlot };
  const expired = nonceAccount ? await nonceValue(rpc, nonceAccount, null, finalized) !== signedValue : epoch.blockHeight > lastHeight;
  const account = await rpc.getAccountInfo(receipt, finalized);
  if (!account) return { ok: true, expired };
  if (account.owner !== program || account.data.length !== 132 || account.data.toString('ascii', 0, 8) !== 'PFSOLRC1' ||
      account.data.toString('hex', 68, 100) !== nonce) {
    return { ok: true, expired };
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
