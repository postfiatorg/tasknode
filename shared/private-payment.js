// Browser and gateway sign the same off-chain request, including its destination and amount.
export const privateSignatureContext = new TextEncoder().encode('tasknode/private-wallet/request/v1');
export const privatePaths = new Set(['wallet/create', 'abandon', 'address', 'balance', 'shield/prepare', 'shield/finish', 'pay', 'exit', 'receipt']);
export const poolAddress = /^pfs1[0-9a-f]{158}$/;
export const publicAccount = /^pf[0-9a-f]{40}$/;
export const assetId = /^[0-9a-f]{96}$/;
// JSON numbers above the safe range travel as canonical decimal strings inside Task Node.
export function isU64(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
}
export function privateMessage(accountId, path, body, expires) {
  return new TextEncoder().encode(JSON.stringify([accountId, path, body, expires]));
}

export const operationStates = new Set(['built', 'unsubmitted', 'queued', 'dispatched', 'delivery_unknown',
  'pending_unknown', 'unknown', 'refused', 'rejected', 'accepted', 'abandoned']);
export const missingDraft = 'This unsigned quote is no longer active. It holds no funds.';
export const restoreMessage = 'Private balance needs restoring, contact support.';

const policyReasons = {
  asset_orchard_transfer_facility_asset: 'This asset is on the redemption facility and cannot be made private.',
  asset_orchard_transfer_reserve_outstanding: 'This asset still has funds in the private reserve. Its policy prevents this action.',
  'restricted asset requires an authorized destination line': 'The destination needs authorization to receive this restricted asset.',
  'public transfer edge requires a confirmed ungoverned policy': 'The asset policy prevents this move between public and private balances.',
};
export function refusalMessage(code) {
  if (Object.hasOwn(policyReasons, code)) return policyReasons[code];
  if (Object.values(policyReasons).includes(code)) return code;
  if (/^asset_orchard_(?:(?:private_)?egress_policy_[a-z_]+|transfer_(?:entry|exit)_policy_governed)$/.test(code)) {
    return policyReasons['public transfer edge requires a confirmed ungoverned policy'];
  }
  return '';
}

export function finalizedAcceptance(id, receipt) {
  const f = receipt?.finality;
  return receipt?.intent_id === id && receipt.state === 'accepted' && receipt.accepted === true &&
    f?.kind === 'validator_quorum_block_certificate_v1' && Number.isSafeInteger(f.height) && f.height > 0 &&
    f.height === receipt.inclusion_height && assetId.test(f.block_hash) && f.block_hash === receipt.block_hash &&
    assetId.test(f.state_root) && f.state_root === receipt.state_root && Number.isSafeInteger(f.quorum) &&
    Number.isSafeInteger(f.validator_count) && f.quorum > 0 && f.quorum <= f.validator_count &&
    typeof f.certificate_json === 'string' && f.certificate_json.length > 0;
}
