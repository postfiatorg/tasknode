import test from 'node:test';
import assert from 'node:assert/strict';
import { amount, plainError, shortId, unitPrice, usd, valueAt } from './format.js';
import { classifyLines } from './portfolio.js';

test('amount trims to the requested decimals without rounding', () => {
  assert.equal(amount(419234350000), '419,234.35');
  assert.equal(amount(2000000), '2.00');
  assert.equal(amount(1), '0.000001');
  assert.equal(amount(-1500000), '−1.50');
  assert.equal(amount(500000000, { sign: true }), '+500.00');
  assert.equal(amount(null), '—');
  assert.equal(usd(valueAt(400000000, 1000000)), '$400.00');
  assert.equal(amount(unitPrice(1204800000, 1200000000), { min: 3, max: 3 }), '1.004');
});

test('identifiers shorten only when long hex', () => {
  assert.equal(shortId('pf' + 'ab'.repeat(20)), 'pfababab…abab');
  assert.equal(shortId('synthetic-accepted-transfer'), 'synthetic-accepted-transfer');
});

test('user-facing errors avoid redemption wording', () => {
  assert.equal(plainError('Amount is outside the currently redeemable capacity and order bounds'), 'Amount is outside the reserve available for cash-ins and order bounds');
  assert.doesNotMatch(plainError('Redemption facility is blocked; redemption reserve low'), /redemption/i);
});

test('portfolio groups PFUSDC family and bridged series, B23 by configured id', () => {
  const config = { b23_asset_id: 'b23', pfusdc_asset_id: 'fam', pfusdc_source_asset_ids: ['child'] };
  const held = classifyLines([{ asset_id: 'fam', balance: 5 }, { asset_id: 'child', balance: 7, asset_family_id: 'fam' }, { asset_id: 'b23', balance: 3 }, { asset_id: 'x', code: 'B23', balance: 9 }], config);
  assert.equal(held.pfusdc, 12n); assert.equal(held.pfusdcFamily, 5n); assert.equal(held.pfusdcBridged, 7n); assert.equal(held.b23, 3n);
  assert.equal(held.others.length, 1, 'a look-alike B23 code is not counted as B23');
  const noConfig = classifyLines([{ asset_id: 'any', code: 'PFUSDC', balance: 4 }], null);
  assert.equal(noConfig.pfusdc, 4n);
});
