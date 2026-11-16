import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoCustodyMaterial, registerCustodyMaterial, clearCustodyMaterialRegistry } from './custody-boundary.js';
test('custody fields, nested serialized fields and registered secrets cannot leave browser', () => {
  for (const payload of [{seed:'fixture'}, {password:'fixture'}, {operation_json:'{"private_key":"fixture"}'}, {nested:{passphrase:'fixture'}}]) assert.throws(() => assertNoCustodyMaterial(payload), /forbidden custody/);
  registerCustodyMaterial({seed:'a'.repeat(64),passphrase:'1234567890',backupJson:'{"synthetic_secret":"protected-material"}'});
  for (const value of ['a'.repeat(64), '1234567890', '{"synthetic_secret":"protected-material"}']) assert.throws(() => assertNoCustodyMaterial({memo:value}), /forbidden custody/);
  assert.doesNotThrow(() => assertNoCustodyMaterial({signature_hex:'valid-public-signature',public_key_hex:'public-key'}));
  clearCustodyMaterialRegistry();
});
