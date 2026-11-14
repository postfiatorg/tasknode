import { createHash } from 'node:crypto';
import { createProfileRpc, memoRead } from './profile/rpc.js';
import { proofProfileId } from './profile/proof-profile.js';
import { boundPublicValues } from './profile/public-values.js';
import { profileCoins } from './profile/coins.js';
import { readEthereumPool } from './profile/ethereum.js';
import { ethereumSnapshotTransactions } from './profile/ethereum-history.js';
const GROUPS = ['transactions', 'payments_v2', 'asset_transactions', 'atomic_swap_transactions', 'escrow_transactions', 'nft_transactions', 'offer_transactions'];
const digest = bytes => bytes?.length ? createHash('sha256').update(Buffer.from(bytes)).digest('hex') : null;
const fields = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
export function depth(book, coin, height, side = 'asks') {
  if (!book || !Array.isArray(book.offers)) return null;
  const asks = side === 'asks', gets = asks ? coin.asset_id : coin.market_quote_asset_id, pays = asks ? coin.market_quote_asset_id : coin.asset_id;
  let coins = 0n, quote = 0n, count = 0;
  for (const offer of book.offers) {
    if (offer.state !== 'open' || offer.taker_gets_asset_id !== gets || offer.taker_pays_asset_id !== pays || (offer.expiration_height && Number(offer.expiration_height) <= height)) continue;
    const size = BigInt(asks ? offer.taker_gets_amount_remaining : offer.taker_pays_amount_remaining), value = BigInt(asks ? offer.taker_pays_amount_remaining : offer.taker_gets_amount_remaining);
    if (size <= 0n || value <= 0n) continue;
    coins += size; quote += value; count++;
  }
  return { coin_atoms: String(coins), quote_atoms: String(quote), offers: count, partial: book.truncated === true };
}
export function transactionsInBlock(block, archive) {
  if (block.header.batch_kind !== 'transparent') return [];
  const entry = archive.find(row => row.batch_id === block.header.batch_id && row.batch_kind === block.header.batch_kind);
  if (!entry) throw Error('Committed transaction archive unavailable');
  const payloadHash = block.header.consensus_v2_commit?.precommit_qc?.block?.payload_hash;
  if (payloadHash && payloadHash !== entry.payload_hash) throw Error('Archive payload hash does not match the committed block');
  const batch = JSON.parse(entry.payload_json);
  if (batch.batch_id !== block.header.batch_id) throw Error('Archive batch identity mismatch');
  const txs = GROUPS.flatMap(key => batch[key] || []);
  if (txs.length !== block.receipt_ids.length) throw Error('Archive receipt count mismatch');
  return txs.map((tx, i) => ({ tx_id: block.receipt_ids[i], operation: typeof tx.unsigned?.operation === 'object' ? { ...tx.unsigned, ...tx.unsigned.operation } : tx.unsigned,
    block: fields(block.header, ['height', 'block_hash', 'parent_hash', 'batch_id', 'state_root', 'timestamp', 'timestamp_ms']), archive_payload_hash: entry.payload_hash }));
}
export function createProfileReader({ rpc = createProfileRpc(), coins = () => profileCoins, ethereum = readEthereumPool } = {}) {
  const getBlock = memoRead(async height => {
    const blocks = await rpc('blocks', { from_height: height, limit: 1 });
    const block = blocks.find(item => Number(item.header.height) === height);
    if (!block) throw Error('Committed block unavailable');
    if (block.header.batch_kind !== 'transparent') return [];
    return transactionsInBlock(block, await rpc('batch_archive', { batch_kind: 'transparent', batch_id: block.header.batch_id }));
  }, 24 * 60 * 60 * 1000);
  const receipt = memoRead(async entry => {
    if (!entry) return null;
    const receipts = await rpc('receipts', { tx_id: entry.tx_id });
    const literal = receipts.find(row => row.tx_id === entry.tx_id);
    if (!literal || receipts.some(row => row.tx_id !== entry.tx_id || JSON.stringify(row) !== JSON.stringify(literal))) throw Error('Missing or conflicting transaction receipts');
    return { tx_id: entry.tx_id, block: entry.block, receipt: literal, confirmed: true, confirmation_basis: 'Transaction ID included in the committed block and matching signed batch archive', archive_payload_hash: entry.archive_payload_hash };
  }, 24 * 60 * 60 * 1000);
  const readBase = memoRead(async slug => {
    const coin = (await coins()).find(item => item.slug === slug);
    if (!coin) throw Object.assign(Error('NAVCoin not found'), { status: 404 });
    const proof = await rpc('nav_reserve_proof_status', { asset_id: coin.asset_id });
    if (!proof.found || proof.asset_id !== coin.asset_id) throw Error('NAVCoin identity unavailable');
    const errors = [];
    async function optional(label, method, params) { try { return await rpc(method, params); } catch { errors.push(`${label} not available`); return null; } }
    // Bound concurrent validator work; all calls are read-only.
    const asset = (await optional('Supply', 'asset_info', { asset_id: coin.asset_id }))?.asset;
    const route = coin.route_id ? await optional('Cash-in route', 'navcoin_bridge_supply_status', { route_id: coin.route_id }) : null;
    if (asset && asset.asset_id !== coin.asset_id || route && route.native_nav_asset_id !== coin.asset_id) throw Error('NAVCoin route identity mismatch');
    const asks = coin.market_quote_asset_id ? await optional('Sell offers', 'book_offers', { taker_gets_asset_id: coin.asset_id, taker_pays_asset_id: coin.market_quote_asset_id, limit: 512 }) : null;
    const bids = coin.market_quote_asset_id ? await optional('Buy offers', 'book_offers', { taker_gets_asset_id: coin.market_quote_asset_id, taker_pays_asset_id: coin.asset_id, limit: 512 }) : null;
    const history = proof.packets.filter(packet => packet.state === 'finalized').sort((a, b) => Number(a.epoch) - Number(b.epoch)).map(packet => ({ ...packet, verification_url: `#l1-wallet/navcoins/${slug}/snapshots/${packet.epoch}`, evidence_url: `/api/l1/navcoin/profiles/${slug}/snapshots/${packet.epoch}` }));
    return { coin, proof, asset, route, history, latest: history.at(-1) || null, order_book: { asks: depth(asks, coin, proof.current_height), bids: depth(bids, coin, proof.current_height, 'bids'), quote_asset_id: coin.market_quote_asset_id }, errors, observed_at: new Date().toISOString() };
  }, 60000);
  const snapshot = memoRead(async (slug, epoch) => {
    const data = await readBase(slug), packet = data.history.find(item => String(item.epoch) === String(epoch));
    if (!packet) throw Object.assign(Error('Finalized snapshot not found'), { status: 404 });
    const matches = op => op?.asset_id === data.coin.asset_id && Number(op.epoch) === Number(epoch) && op.reserve_packet_hash === packet.reserve_packet_hash;
    const entries = await getBlock(Number(packet.submitted_at_height));
    const submit = entries.find(entry => matches(entry.operation) && entry.operation.operation === 'nav_reserve_submit');
    let finalize = entries.find(entry => matches(entry.operation) && entry.operation.operation === 'nav_epoch_finalize');
    // Search the committed archive, never a hand-written transaction index.
    const next = data.history.find(item => Number(item.epoch) > Number(epoch));
    const end = Math.min(Number(next?.submitted_at_height ?? data.proof.current_height), Number(data.proof.current_height));
    for (let h = Number(packet.submitted_at_height) + 1; !finalize && h <= end; h++) {
      finalize = (await getBlock(h)).find(entry => matches(entry.operation) && entry.operation.operation === 'nav_epoch_finalize');
    }
    const submitReceipt = await receipt(submit), finalizeReceipt = await receipt(finalize);
    const op = submit?.operation;
    let profile = op?.proof_profile === data.proof.active_profile?.profile_id ? data.proof.active_profile : null;
    // A replaced proof profile must not be attributed to an older snapshot.
    if (!profile && op?.proof_profile) {
      for (let h = Number(packet.submitted_at_height) - 1; h >= 1; h--) {
        const registration = (await getBlock(h)).find(entry => entry.operation?.operation === 'nav_profile_register' && proofProfileId(entry.operation.profile || entry.operation) === op.proof_profile);
        if (registration) { const r = await receipt(registration); if (r.receipt.accepted) profile = { ...(registration.operation.profile || registration.operation), profile_id: op.proof_profile }; break; }
      }
    }
    const publicValues = boundPublicValues(op, data.proof.genesis_hash);
    const result = { schema: 'navcoin-snapshot-verification-v1', coin: data.coin, chain_id: data.proof.chain_id, genesis_hash: data.proof.genesis_hash, packet,
      verified: Boolean(submitReceipt?.confirmed && submitReceipt?.receipt.accepted === true && finalizeReceipt?.confirmed && finalizeReceipt?.receipt.accepted === true),
      submit: submitReceipt, finalize: finalizeReceipt, proof_profile_id: op?.proof_profile ?? null, proof_profile: profile,
      proof_program_key: profile?.sp1_program_vkey ?? null, proof_sha256: digest(op?.sp1_proof_bytes), public_values_sha256: digest(op?.sp1_public_values),
      proof_bytes: op?.sp1_proof_bytes?.length ?? null, public_values_bytes: op?.sp1_public_values?.length ?? null,
      decoded_public_values: publicValues,
      reading_time: null, finalized_time: null, attestation: { pcrs: null, image_sha256: null, reading_timestamp: null, source_policy_commitment: publicValues?.source_manifest_hash ?? null,
        observation_not_before_height: publicValues?.observation_not_before ?? null, observation_not_after_height: publicValues?.observation_not_after ?? null, attested_value: publicValues?.attested_value ?? null,
        note: publicValues ? 'Decoded from the archived PFNAV001 public values. Observation bounds are native block heights, not Unix timestamps. The source-policy commitment binds the approved enclave PCRs for Nitro readings; raw PCRs, image hash and UTC reading time are not included in this public packet.' : 'This packet has no PFNAV001 public values. Enclave PCRs, image hash and UTC reading time are not available.' },
      ethereum_transactions: [], ethereum_note: 'No matching Ethereum snapshot transaction has been established from the available chain archive.',
      source: 'Live validator RPC: finalized NAV state, committed blocks, signed batch archive and literal transaction receipts.', read_at: new Date().toISOString() };
    try { result.ethereum_transactions = await ethereumSnapshotTransactions(data.coin, packet, data.route); if (result.ethereum_transactions.length) result.ethereum_note = 'Successful Ethereum receipt publications with matching native asset, route, NAV epoch and reserve-packet commitment. These are not independent rereadings of the underlying assets.'; } catch { result.ethereum_note = 'Ethereum historical publication data is not available from the public RPC. No transaction link is inferred.'; }
    return result;
  }, 24 * 60 * 60 * 1000);
  async function profile(slug) {
    const data = await readBase(slug);
    let pool;
    try { pool = await ethereum(data.coin, data.route, data.latest); } catch (error) { pool = { available: false, error: error.message }; }
    return { ...data, ethereum: pool };
  }
  return { profile, snapshot };
}
export function createProfileHandler(options = {}) {
  const reader = createProfileReader(options);
  return async ({ req, res, url, json }) => {
    const prefix = '/api/l1/navcoin/profiles/';
    if (!url.pathname.startsWith(prefix)) return false;
    if (req.method !== 'GET') { json(res, 405, { error: 'Read-only profile endpoint' }); return true; }
    const match = url.pathname.slice(prefix.length).match(/^([a-z0-9-]+)(?:\/snapshots\/([1-9][0-9]*))?$/);
    if (!match) { json(res, 404, { error: 'Profile not found' }); return true; }
    try { json(res, 200, match[2] ? await reader.snapshot(match[1], match[2]) : await reader.profile(match[1])); }
    catch (error) { json(res, error.status || 502, { error: error.message }); }
    return true;
  };
}
