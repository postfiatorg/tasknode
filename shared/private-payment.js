// Browser and gateway sign the same off-chain request, including its destination and amount.
export const privateSignatureContext = new TextEncoder().encode('tasknode/private-wallet/request/v1');
export const privatePaths = new Set(['address', 'balance', 'shield/prepare', 'shield/finish', 'pay', 'exit', 'receipt']);
export const poolAddress = /^pfs1[0-9a-f]{158}$/;
export const publicAccount = /^pf[0-9a-f]{40}$/;
export const assetId = /^[0-9a-f]{96}$/;
export function privateMessage(accountId, path, body, expires) {
  return new TextEncoder().encode(JSON.stringify([accountId, path, body, expires]));
}
