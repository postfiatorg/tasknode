export const L1_READ_METHODS = new Set([
  'status', 'fee', 'server_info', 'validators', 'account', 'account_tx',
  'account_assets', 'account_lines', 'asset_info', 'issuer_assets',
  'vault_bridge_route', 'vault_bridge_status', 'navcoin_bridge_routes',
  'navcoin_bridge_supply_status', 'nav_reserve_proof_status',
  'book_offers', 'account_offers', 'offer_info', 'receipts', 'receipt', 'tx',
  'transfer_fee_quote', 'asset_fee_quote', 'offer_fee_quote',
  'wallet_subscribe', 'wallet_unsubscribe',
]);
export const L1_SUBMIT_METHODS = new Set([
  'mempool_submit_signed_transfer_finality',
  'mempool_submit_signed_asset_transaction_finality',
  'mempool_submit_signed_offer_transaction',
]);
