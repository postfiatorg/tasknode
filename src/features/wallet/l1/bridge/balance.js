// Receipt acceptance alone is not a balance read. Never substitute the family asset.
export function creditedBalance(response, assetId) {
  if (!/^[0-9a-f]{96}$/.test(assetId || '')) throw new Error('Claim did not identify a credited asset.');
  if (response?.ok !== true || !response.result) throw new Error('Credited PFUSDC balance read failed.');
  const rows = Array.isArray(response.result) ? response.result : response.result.assets;
  if (!Array.isArray(rows)) throw new Error('Malformed account_assets response.');
  const row = rows.find((item) => (item.asset_id || item.id) === assetId);
  if (!row) throw new Error('Credited asset is not yet visible in the account balance. Refresh the result.');
  const amount = row.balance ?? row.amount;
  if ((typeof amount !== 'string' && typeof amount !== 'number') || !/^[0-9]+$/.test(String(amount))
      || (typeof amount === 'number' && !Number.isSafeInteger(amount))) throw new Error('Credited asset balance is malformed.');
  return { assetId, atoms: String(amount) };
}
