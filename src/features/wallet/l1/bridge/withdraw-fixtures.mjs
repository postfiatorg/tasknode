// Synthetic addresses, public IDs and amounts for the local browser test.
export const burn = 'ef'.repeat(48), signature = '1'.repeat(64), recipient = '1'.repeat(32);
export const ready = { ok: true, ready: true, asset_id: '1'.repeat(96), series_asset_id: '2'.repeat(96),
  bucket_id: '3'.repeat(96), issuer: 'pf' + '4'.repeat(40), epoch: 15, reserve_packet_hash: '5'.repeat(96),
  bucket_outstanding_atoms: '30000', current_height: 100, vault_address: '6'.repeat(43),
  relayer_lamports: 30000000, relayer_floor_lamports: 20000000,
  destination_prefix: 'solana-spl:45296998a6f8e2a784db5d9f95e18fc23f70441a1039446801089879b08c7ef0:' };
