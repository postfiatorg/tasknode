export const L1_READ_METHODS = new Set([
  'status', 'fee', 'server_info', 'validators', 'account', 'account_tx',
  'account_assets', 'account_lines', 'asset_info', 'issuer_assets',
  'vault_bridge_route', 'vault_bridge_status', 'navcoin_bridge_routes',
  'navcoin_bridge_supply_status', 'nav_reserve_proof_status', 'pftl_uniswap_receipt',
  'book_offers', 'account_offers', 'offer_info', 'receipts', 'receipt', 'tx',
  'transfer_fee_quote', 'asset_fee_quote', 'offer_fee_quote',
  'wallet_subscribe', 'wallet_unsubscribe',
  // Train A & Train B (Pillars 6, 7, 8) frozen read RPCs
  'identity_info', 'identity_by_nostr', 'identity_by_handle', 'identity_by_link',
  'nav_fee_schedule', 'nav_fee_history',
  'account_bridge_holds', 'asset_bridge_holds',
  'did_resolve', 'issuer_info', 'issuer_list', 'credential_info', 'account_credentials', 'asset_access_info',
]);
export const L1_SUBMIT_METHODS = new Set([
  'mempool_submit_signed_transfer_finality',
  'mempool_submit_signed_asset_transaction',
  'mempool_submit_signed_asset_transaction_finality',
  'mempool_submit_signed_offer_transaction_finality',
]);

export function assertL1CallAllowed(method, unlocked) {
  if (L1_READ_METHODS.has(method)) return;
  if (!L1_SUBMIT_METHODS.has(method)) throw new Error('L1 method is not allowed');
  if (!unlocked) throw new Error('Unlock your L1 wallet before submitting');
}
