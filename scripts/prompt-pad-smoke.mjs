import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promptPadSecrets, newPromptCapability } from '../packages/tasknode-cli/lib/prompt-pad.mjs';
const require = createRequire(new URL('../packages/tasknode-cli/package.json',import.meta.url));
const Crypto = require('chainpad-crypto');
// Public deterministic fixture; expected channel checked against PFDocs common-hash.
// CryptPad maps '-' to '/', unlike the usual base64url alphabet.
const keys = Crypto.createEditCryptor2(undefined,new Uint8Array(18).fill(2));
assert.ok(keys.chanId.includes('-'));
const href = `/code/#/2/code/edit/${Crypto.b64RemoveSlashes(keys.editKeyStr)}/`;
assert.equal(promptPadSecrets('http://localhost:3190',href).channel,'1a835d72a1d32fe19b85708fe71fe9f0');
assert.throws(() => promptPadSecrets('http://localhost:3190','https://wrong.invalid'+href));
assert.throws(() => promptPadSecrets('http://localhost:3190',href.replace('/edit/','/view/')));
for (let i=0;i<32;i++) {
  const capability = newPromptCapability('http://localhost:3190');
  assert.equal(promptPadSecrets('http://localhost:3190',capability.editHref).channel,capability.channelHash);
}
console.log('PASS prompt pad: PFDocs channel vector, custom base64 alphabet, edit-only capabilities, exact origin, create/reopen agreement');
