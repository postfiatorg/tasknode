import { Interface } from 'ethers';
import { memoRead } from './rpc.js';
const RPC = 'https://ethereum-rpc.publicnode.com';
export const POOL_MANAGER = '0x000000000004444c5dc75cb358380d2e3de08a90';
const STATE_VIEW = '0x7ffe42c4a5deea5b0fec41c94c136cf115597227';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11';
const abi = new Interface([
  'function uniswapPoolId() view returns (bytes32)', 'function mintPaused() view returns (bool)', 'function wrappedToken() view returns (address)',
  'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)',
  'function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)', 'function getLiquidity(bytes32) view returns (uint128)',
  'function getTickBitmap(bytes32,int16) view returns (uint256)', 'function getTickLiquidity(bytes32,int24) view returns (uint128,int128)',
]);
const multi = new Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
export async function ethRpc(method, params) {
  const response = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error('Ethereum public RPC unavailable');
  const body = await response.json();
  if (body.error || body.result === undefined) throw Error(`Ethereum ${method} unavailable`);
  return body.result;
}
async function calls(items, block) {
  const data = multi.encodeFunctionData('aggregate3', [items.map(([target, method, args = []]) => ({ target, allowFailure: true, callData: abi.encodeFunctionData(method, args) }))]);
  const result = multi.decodeFunctionResult('aggregate3', await ethRpc('eth_call', [{ to: MULTICALL, data }, block]))[0];
  return result.map((entry, i) => entry.success ? abi.decodeFunctionResult(items[i][1], entry.returnData) : null);
}
// V4 holds assets in one shared PoolManager. Its ERC-20 balance is NOT a pool's
// balance. Recover this pool's principal from every initialized liquidity tick.
export function principalFromTicks(ticks, sqrtPrice, activeLiquidity, currentTick) {
  let liquidity = 0n, amount0 = 0, amount1 = 0, atCurrent = 0n;
  const sorted = [...ticks].sort((a, b) => a.tick - b.tick), sqrt = Number(sqrtPrice) / 2 ** 96;
  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i]; liquidity += BigInt(item.net);
    if (liquidity < 0n) throw Error('Ethereum tick liquidity is inconsistent');
    if (item.tick <= currentTick) atCurrent = liquidity;
    const next = sorted[i + 1]; if (!next || liquidity === 0n) continue;
    const lower = 1.0001 ** (item.tick / 2), upper = 1.0001 ** (next.tick / 2), l = Number(liquidity);
    if (sqrt <= lower) amount0 += l * (1 / lower - 1 / upper);
    else if (sqrt >= upper) amount1 += l * (upper - lower);
    else { amount0 += l * (1 / sqrt - 1 / upper); amount1 += l * (sqrt - lower); }
  }
  if (liquidity !== 0n || atCurrent !== BigInt(activeLiquidity)) throw Error('Ethereum tick coverage is incomplete');
  return { amount0, amount1 };
}
async function readPool(coin, route) {
  if (coin.retired || !route || route.ethereum_chain_id !== 1) return { available: false, deployed: false, note: coin.retired ? 'No Ethereum pool is published for this retired coin.' : 'Not deployed yet.' };
  const token = route.wrapped_navcoin_token, controller = route.handoff_controller;
  if (!/^0x[0-9a-f]{40}$/i.test(token || '') || !/^0x[0-9a-f]{40}$/i.test(controller || '')) return { available: false, deployed: false, note: 'Not deployed yet.' };
  const block = await ethRpc('eth_blockNumber', []);
  const code = await ethRpc('eth_getCode', [token, block]);
  if (code === '0x') return { available: false, deployed: false, note: 'Not deployed yet.' };
  const [id, paused, decimals, supply] = await calls([[controller, 'uniswapPoolId'], [controller, 'mintPaused'], [token, 'decimals'], [token, 'totalSupply']], block);
  if (!id || !decimals) throw Error('Ethereum pool binding unavailable');
  const poolId = id[0];
  const [slot, active] = await calls([[STATE_VIEW, 'getSlot0', [poolId]], [STATE_VIEW, 'getLiquidity', [poolId]]], block);
  if (!slot || !active || slot[0] === 0n) throw Error('Ethereum pool not initialized');
  // The supported hookless 500-fee pools have spacing 10. Their pool IDs are
  // checked against the full key below, so a different spacing cannot slip in.
  const { AbiCoder, keccak256 } = await import('ethers');
  const tokenFirst = BigInt(token) < BigInt(USDC), fee = 500, spacing = 10;
  const key = [tokenFirst ? token : USDC, tokenFirst ? USDC : token, fee, spacing, '0x0000000000000000000000000000000000000000'];
  const expected = keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], key));
  if (expected.toLowerCase() !== poolId.toLowerCase()) throw Error('Ethereum pool key does not match the published token and USDC');
  const tickRows = [];
  for (let word = -347; word <= 346; word += 100) {
    const words = Array.from({ length: Math.min(100, 347 - word) }, (_, i) => word + i);
    const maps = await calls(words.map(w => [STATE_VIEW, 'getTickBitmap', [poolId, w]]), block);
    for (let i = 0; i < words.length; i++) {
      if (!maps[i]) throw Error('Ethereum pool tick bitmap unavailable');
      const bits = maps[i][0];
      for (let bit = 0; bit < 256; bit++) if (bits & (1n << BigInt(bit))) tickRows.push((words[i] * 256 + bit) * spacing);
    }
  }
  const ticks = [];
  for (let i = 0; i < tickRows.length; i += 100) {
    const group = tickRows.slice(i, i + 100), values = await calls(group.map(tick => [STATE_VIEW, 'getTickLiquidity', [poolId, tick]]), block);
    values.forEach((value, n) => { if (!value) throw Error('Ethereum pool tick unavailable'); ticks.push({ tick: group[n], net: value[1].toString() }); });
  }
  const principal = principalFromTicks(ticks, slot[0], active[0], Number(slot[1]));
  const d = Number(decimals[0]), rawPrice = (Number(slot[0]) / 2 ** 96) ** 2;
  return { available: true, deployed: true, block_number: Number(BigInt(block)), observed_at: new Date().toISOString(), cache_seconds: 60,
    token, controller, pool_id: poolId, pool_manager: POOL_MANAGER, state_view: STATE_VIEW, token_decimals: d, wrapped_supply: supply ? Number(supply[0]) / 10 ** d : null,
    mint_paused: paused?.[0] ?? null, liquidity: active[0].toString(), price_usdc: tokenFirst ? rawPrice * 10 ** (d - 6) : 10 ** (d - 6) / rawPrice,
    lp_fee: Number(slot[3]), protocol_fee: Number(slot[2]), tick_spacing: spacing, initialized_ticks: ticks.length,
    coin_balance: (tokenFirst ? principal.amount0 : principal.amount1) / 10 ** d, usdc_balance: (tokenFirst ? principal.amount1 : principal.amount0) / 1e6,
    balance_basis: 'Estimated liquidity principal across all initialized ticks at the pinned Ethereum block, excluding uncollected fees. Uniswap v4 uses a shared manager; its combined wallet balance is not this pool’s balance.',
    ticks, sqrt_price_x96: slot[0].toString(), current_tick: Number(slot[1]) };
}
export const readEthereumPool = memoRead(readPool, 60000);
