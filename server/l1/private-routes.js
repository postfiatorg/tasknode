import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { checkRouteRateLimit } from '../rate-limit.js';
import { assetId, isU64, poolAddress, privateMessage, privatePaths, privateSignatureContext, publicAccount } from '../../shared/private-payment.js';
import { exactFields as fields, lowerHex as hex, validFundingAuthorization } from '../../shared/private-funding.js';
import { privatePaymentsEnabled } from './release-config.js';
import { PrivateError, privatePost, unavailable } from './private-transport.js';

const requireField = valid => { if (!valid) throw new PrivateError(400, 'The private wallet request is invalid.', true); };

function verifiedAccount(accountId, path, { body, proof }) {
  if (!fields(proof, ['expires', 'publicKey', 'signature']) || !hex(proof.publicKey, 3904) || !hex(proof.signature, 6618) ||
      !Number.isSafeInteger(proof.expires) || proof.expires < Date.now() || proof.expires > Date.now() + 120000) return null;
  const pk = Buffer.from(proof.publicKey, 'hex');
  if (!ml_dsa65.verify(Buffer.from(proof.signature, 'hex'), privateMessage(accountId, path, body, proof.expires), pk, { context: privateSignatureContext })) return null;
  return 'pf' + createHash('sha3-384').update('postfiat.address.v1\0').update(pk).digest('hex').slice(0, 40);
}

// Authenticated handles survive gateway restarts and work across replicas. The daemon has no owner argument on these two calls.
function handleTag(secret, accountId, account, id) {
  return createHmac('sha256', secret).update(JSON.stringify(['private-wallet-handle-v1', accountId, account, id])).digest('hex');
}
function proverBody(path, body, account, tag, publicKey) {
  if (path === 'receipt' || path === 'shield/finish') {
    const finish = path === 'shield/finish', key = finish ? 'pending_id' : 'intent_id';
    requireField(fields(body, finish ? [key, 'owner_tag', 'funding_authorization'] : [key, 'owner_tag']) && hex(body[key], finish ? 64 : 96));
    if (!hex(body.owner_tag, 64) || !timingSafeEqual(Buffer.from(body.owner_tag), Buffer.from(tag(body[key])))) throw new PrivateError(403, 'This reference belongs to another wallet or is invalid.', true);
    if (!finish) return { intent_id: body.intent_id };
    const auth = body.funding_authorization;
    requireField(validFundingAuthorization(auth) && auth.unsigned.terms.source === account && auth.public_key_hex === publicKey);
    return { pending_id: body.pending_id, funding_authorization: auth };
  }
  if (path === 'abandon') {
    const key = ['pending_id', 'intent_id', 'request_id'].find(k => Object.hasOwn(body || {}, k));
    if (key === 'request_id') requireField(fields(body, [key]) && typeof body[key] === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(body[key]));
    else {
      requireField(key && fields(body, [key, 'owner_tag']) && hex(body[key], key === 'pending_id' ? 64 : 96));
      if (!hex(body.owner_tag, 64) || !timingSafeEqual(Buffer.from(body.owner_tag), Buffer.from(tag(body[key])))) throw new PrivateError(403, 'Invalid wallet reference.', true);
    }
    return { wallet_id: account, [key]: body[key] };
  }
  if (['wallet/create','address','balance'].includes(path)) {
    requireField(fields(body, []));
    return { wallet_id: account };
  }
  const prepare = path === 'shield/prepare', dest = path === 'pay' ? 'recipient' : 'destination';
  requireField(fields(body, prepare ? ['asset','amount'] : ['asset','amount','request_id', dest]) &&
    typeof body.asset === 'string' && assetId.test(body.asset) && isU64(body.amount) && BigInt(body.amount) > 0n);
  if (prepare) return { ...body, wallet_id: account, account };
  requireField(typeof body.request_id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(body.request_id) &&
    typeof body[dest] === 'string' && (path === 'pay' ? poolAddress : publicAccount).test(body[dest]));
  return { ...body, wallet_id: account };
}
export async function handlePrivateRoutes({ req, res, url, session, json, readJson, env, relay }) {
  const path = url.pathname.slice('/api/l1/private/'.length);
  const fail = (status, error, unchanged) => json(res, status, { error, unchanged });
  if (!privatePaymentsEnabled(env) || !privatePaths.has(path)) return fail(404, 'Private payments are unavailable.', true);
  if (req.method !== 'POST' || url.search) return fail(405, 'Use a private wallet POST request.', true);
  try {
    const write = ['wallet/create','abandon','shield/prepare','shield/finish','pay','exit'].includes(path);
    const bucket = 'private-wallet-' + (write ? 'write' : 'read');
    const limit = await checkRouteRateLimit({ key: bucket + ':' + session.accountId, route: bucket, limit: write ? 12 : 90, env });
    if (!limit.allowed) return fail(429, 'Too many private wallet requests. Try again shortly.', true);
    const request = await readJson(req, 32768);
    requireField(fields(request, ['body', 'proof']));
    const account = verifiedAccount(session.accountId, path, request);
    if (!account) return fail(403, 'Unlock the L1 wallet for this account and try again.', true);
    if (!relay) return fail(503, unavailable, true);
    const tag = id => handleTag(env.TASKNODE_AUTH_SECRET?.length >= 32 ? env.TASKNODE_AUTH_SECRET : relay.token, session.accountId, account, id);
    const body = proverBody(path, request.body, account, tag, request.proof.publicKey);
    const result = await privatePost(relay.origin, path, body, relay.token, true);
    if (path === 'receipt' && body.intent_id !== result.intent_id) throw Error(unavailable);
    if (result.pending_id || result.intent_id) result.owner_tag = tag(result.pending_id || result.intent_id);
    json(res, 200, result);
  } catch (error) {
    if (error instanceof PrivateError) return fail(error.status, error.message, error.unchanged);
    if ([400, 413, 415].includes(error.status)) return fail(error.status, 'Invalid or oversized private wallet request.', true);
    fail(503, unavailable, false);
  }
}
