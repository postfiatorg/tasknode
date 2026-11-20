// Vault ABI: pfusdc-vault/src/lib.rs, deposit tag 1, classic SPL Token.
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { address, getProgramDerivedAddress } from '@solana/addresses';
import { AccountRole } from '@solana/instructions';
import { compileTransactionMessage, getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder } from '@solana/transaction-messages';
import bs58 from 'bs58';
import { checkDepositShape, COMPUTE_BUDGET_PROGRAM, MAX_COMPUTE_UNIT_PRICE } from '../../src/features/wallet/l1/bridge/solana-shape.js';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SYSTEM = '11111111111111111111111111111111';
const RECENT_BLOCKHASHES = 'SysvarRecentB1ockHashes11111111111111111111';
// A depositor may hold a nonce for this long before it is offered to someone else.
const NONCE_LEASE_MS = 11 * 60 * 1000;
// Every deposit sets its own compute budget, so a wallet has nothing to add. Without one, the deposit
// instruction ran under the runtime's implicit 200,000-unit default; the limit keeps that ceiling and
// adds 150 units each for AdvanceNonce and the two compute-budget instructions.
export const DEPOSIT_COMPUTE_UNIT_LIMIT = 200_000 + 3 * 150;
// Price in micro-lamports per unit: the larger of the median recent priority fee on the deposit's
// writable accounts and the UNSCOPED_FEE_PERCENTILE of recent fees across Solana, clamped to
// [MIN_COMPUTE_UNIT_PRICE, MAX_COMPUTE_UNIT_PRICE]. The deposit's own accounts are mostly fresh and
// quiet, and the fees across Solana are each slot's lowest landed price, usually 0, so in normal
// conditions both stay below the minimum, which sets the price: 100,000 × the limit ≈ 0.00002 SOL.
// An unread list counts as none.
export const MIN_COMPUTE_UNIT_PRICE = 100_000;
export const UNSCOPED_FEE_PERCENTILE = 75;
// Background re-send loops, each kind with its own budget so durable loops cannot crowd out the
// short blockhash ones. Calls over a budget are broadcast once.
export const MAX_DURABLE_RESEND_LOOPS = 16;
export const MAX_BLOCKHASH_RESEND_LOOPS = 8;
// A durable loop stops after this long, and every READINESS_EVERY re-sends it stops once deposits close.
export const DURABLE_RESEND_MS = 3 * 60 * 1000;
export const READINESS_EVERY = 5;
// Nonce account -> { value, until, holder, intent, sent }. A holder is one signed-in account.
const leases = new Map();
const loops = { durable: 0, blockhash: 0 }, looping = new Set();
let leasing = Promise.resolve(), authorityWarned = false;
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
      const { context, value } = await call('getAccountInfo', [key, { commitment: 'finalized', encoding: 'base64', ...options }]);
      if (!value) return null;
      if (value.data?.[1] !== 'base64') throw Error('Invalid Solana account encoding');
      return { owner: value.owner, data: Buffer.from(value.data[0], 'base64'), slot: context?.slot };
    },
    getEpochInfo: () => call('getEpochInfo', [{ commitment: 'finalized' }]),
    getLatestBlockhash: async () => (await call('getLatestBlockhash', [{ commitment: 'confirmed' }])).value,
    getRecentPrioritizationFees: accounts => call('getRecentPrioritizationFees', [accounts]),
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
// Also returns the slot the value was read at.
async function nonceState(rpc, account, authority, options) {
  const info = await rpc.getAccountInfo(account, options);
  const valid = info?.owner === SYSTEM && info.data.length === 80 && info.data.readUInt32LE(4) === 1 &&
    (!authority || bs58.encode(info.data.subarray(8, 40)) === authority);
  return { value: valid ? bs58.encode(info.data.subarray(40, 72)) : null, slot: info?.slot };
}
const nonceValue = async (...args) => (await nonceState(...args)).value;

// Any live lease on this account and value: nobody else is offered it.
const taken = (account, value) => {
  const lease = leases.get(account);
  return lease?.value === value && lease.until > Date.now();
};
// The live lease of this very deposit (intent = its 32-byte nonce).
const held = ({ nonce_account: account, nonce_value: value }, intent) => taken(account, value) && leases.get(account).intent === intent;

// A transaction on a recent blockhash is valid for 150 blocks, about half a minute, which is
// less than a careful approval in Phantom takes. A durable nonce keeps it valid until used.
// Returns a free nonce account, or null when all are out. A holder keeps at most one unsent lease;
// a lease marked sent stays until its nonce moves or it ends. The holder's own lapsed lease comes
// first, so a new deposit replaces that holder's old one rather than another holder's.
function leaseNonce({ rpc }, signer, holder, intent) {
  const turn = leasing.then(async () => {
    const now = Date.now();
    const own = new Set(holder ? [...leases].filter(([, lease]) => lease.holder === holder && lease.until <= now).map(([account]) => account) : []);
    if (holder) for (const [account, lease] of leases) if (lease.holder === holder && !lease.sent) leases.delete(account);
    for (const account of [...signer.accounts].sort((a, b) => own.has(b) - own.has(a))) {
      const value = await nonceValue(rpc, account, signer.authority, { commitment: 'confirmed' });
      if (!value || taken(account, value)) continue;
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
    if (holder && lease.holder === holder && lease.intent === intent && !lease.sent) { leases.delete(account); return { ok: true, released: true }; }
  }
  return { ok: true, released: false };
}

// pick(sorted recent fees) for these accounts (none: across Solana), or 0 when unread or malformed.
async function recentFee(rpc, accounts, pick) {
  try {
    const fees = (await rpc.getRecentPrioritizationFees(accounts)).map(row => row.prioritizationFee);
    return fees.length && fees.every(Number.isSafeInteger) ? pick(fees.sort((a, b) => a - b)) : 0;
  } catch { return 0; }
}

async function computePrice(rpc, accounts) {
  const [scoped, unscoped] = await Promise.all([recentFee(rpc, accounts, fees => fees[fees.length >> 1]),
    recentFee(rpc, [], fees => fees[Math.ceil(fees.length * UNSCOPED_FEE_PERCENTILE / 100) - 1])]);
  return Math.min(MAX_COMPUTE_UNIT_PRICE, Math.max(MIN_COMPUTE_UNIT_PRICE, scoped, unscoped));
}

function computeBudget(price) {
  const limit = Buffer.alloc(5), fee = Buffer.alloc(9);
  limit[0] = 2;
  limit.writeUInt32LE(DEPOSIT_COMPUTE_UNIT_LIMIT, 1);
  fee[0] = 3;
  fee.writeBigUInt64LE(BigInt(price), 1);
  return [limit, fee].map(data => ({ programAddress: address(COMPUTE_BUDGET_PROGRAM), data }));
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
    const [block, price] = await Promise.all([rpc.getLatestBlockhash(),
      computePrice(rpc, [owner, source.pubkey, config, custody, receipt, ...(durable ? [durable.account] : [])])]);
    // System AdvanceNonceAccount (4) must come first, signed by the nonce authority. Then the compute budget.
    const advance = durable && { programAddress: address(SYSTEM), data: Buffer.from([4, 0, 0, 0]), accounts: [
      { address: durable.account, role: WRITABLE }, { address: address(RECENT_BLOCKHASHES), role: READONLY },
      { address: signer.authority, role: READONLY_SIGNER }] };
    const message = compileTransactionMessage({ version: 'legacy', feePayer: { address: owner },
      lifetimeConstraint: { blockhash: durable ? durable.value : block.blockhash, lastValidBlockHeight: BigInt(block.lastValidBlockHeight) },
      instructions: [...(durable ? [advance] : []), ...computeBudget(price), deposit] });
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
// durable-nonce one stays valid until its nonce moves: re-send while the lease is held and it has
// not, for at most DURABLE_RESEND_MS. resend.open reports whether deposits are still open.
export async function sendDeposit(settings, { transaction_b64: encoded, nonce }, resend = {}) {
  const { every = 2000, times = 14, open = null, durableMs = DURABLE_RESEND_MS } = resend;
  const { rpc, program, mint } = settings;
  const bytes = Buffer.from(encoded, 'base64');
  const refuse = message => new DepositError(400, message, 'solana_deposit_shape_mismatch');
  // One signature (the depositor) or two (the depositor, then the nonce authority).
  const signers = bytes[0], start = 1 + 64 * signers;
  if (![1, 2].includes(signers) || bytes.length <= start || bytes.length > 1232 || bytes.subarray(1, 65).every(b => b === 0)) {
    throw refuse('Phantom did not return a signed deposit.');
  }
  const pool = signers === 2 && settings.nonceFile ? JSON.parse(await readFile(settings.nonceFile, 'utf8')) : null;
  let shape;
  try {
    if (signers === 2 && !pool) throw Error('no nonce file');
    shape = await checkDepositShape(bytes, { program, mint, nonce, ...(pool && { nonce_authority: pool.authority, nonceAccounts: pool.accounts }) }, { signed: true });
    // The authority signs only messages this server built, so its signature proves the message is unchanged.
    const authority = shape.durable && createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'),
      bs58.decode(shape.durable.nonce_authority)]), format: 'der', type: 'spki' });
    if (authority && !verify(null, shape.message, authority, bytes.subarray(65, 129))) throw Error('authority signature');
  } catch { throw refuse('The signed transaction is not this vault deposit.'); }
  const { signature, durable } = shape;
  await rpc.sendTransaction(encoded, { preflightCommitment: 'confirmed', maxRetries: 3 });
  // Sent: a new intent of the same holder no longer drops this lease.
  if (durable && held(durable, nonce)) leases.get(durable.nonce_account).sent = true;
  const kind = durable ? 'durable' : 'blockhash';
  if (looping.has(signature) || loops[kind] >= (durable ? MAX_DURABLE_RESEND_LOOPS : MAX_BLOCKHASH_RESEND_LOOPS)) return { ok: true, signature };
  loops[kind]++;
  looping.add(signature);
  const ends = Date.now() + durableMs;
  (async () => {
    for (let i = 1; durable ? Date.now() < ends : i <= times; i++) {
      await new Promise(resolve => setTimeout(resolve, every));
      try {
        if (await rpc.getSignatureStatus(signature)) return;
        if (open && i % READINESS_EVERY === 0 && !await open()) return;
        if (durable && !(held(durable, nonce) && await nonceValue(rpc, durable.nonce_account, durable.nonce_authority, { commitment: 'confirmed' }) === durable.nonce_value)) return;
        await rpc.sendTransaction(encoded, { skipPreflight: true, maxRetries: 0 });
      } catch {
        // Expiry ends a blockhash loop; recovery reads the vault. A durable loop ends with its lease.
        if (durable && !held(durable, nonce)) return;
      }
    }
  })().finally(() => { loops[kind]--; looping.delete(signature); });
  return { ok: true, signature };
}

// Phantom may have broadcast before its reply reached the tab. Only the vault can create
// this permanent receipt. Read a finalized bank after expiry before releasing the form. A
// durable-nonce deposit expires only once its nonce has moved past the signed value: read the
// nonce first and the receipt at or after that read's slot, so a deposit that lands between the
// two reads is seen by the receipt read. While the nonce is unchanged, `resend` says the lease is
// still held, so the browser may send its signed copy again; `lapsed` says the lease has ended.
export async function recoverDeposit({ rpc, program }, { nonce, last_valid_block_height: lastHeight, vault_program_id: expected, before,
  nonce_account: nonceAccount, nonce_value: signedValue }) {
  if (program !== expected) throw new DepositError(409, 'This deposit belongs to a different vault configuration.');
  const receipt = await pda(program, 'receipt', Buffer.from(nonce, 'hex'));
  const epoch = await rpc.getEpochInfo();
  const read = nonceAccount && await nonceState(rpc, nonceAccount, null, { commitment: 'finalized', minContextSlot: epoch.absoluteSlot });
  const expired = nonceAccount ? read.value !== signedValue : epoch.blockHeight > lastHeight;
  const account = await rpc.getAccountInfo(receipt, { commitment: 'finalized',
    minContextSlot: Math.max(epoch.absoluteSlot, Number.isSafeInteger(read?.slot) ? read.slot : 0) });
  const waiting = nonceAccount && !expired && (held({ nonce_account: nonceAccount, nonce_value: signedValue }, nonce) ? { resend: true } : { lapsed: true });
  if (!account) return { ok: true, expired, ...waiting };
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
