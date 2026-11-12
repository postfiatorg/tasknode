// First-party source: postfiatl1v2 wallet-web/src/wasm. No binaries in git.
import { copyFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const source = process.argv[2];
if (!source) throw new Error('Usage: node src/features/wallet/l1/prepare-wasm.mjs /path/to/postfiat_wallet_wasm_bg.wasm');
const bytes = await readFile(source);
if (bytes.subarray(0, 4).toString('hex') !== '0061736d') throw new Error('Not a WASM artifact');
const digest = createHash('sha256').update(bytes).digest('hex');
if (digest !== 'affd340817788d45a313e60ec512493c6c56c3acbf81a4d4159636279ea0c882') throw new Error('WASM artifact does not match the qualified wallet package');
await copyFile(source, new URL('./wasm/postfiat_wallet_wasm_bg.wasm', import.meta.url));
console.log('Prepared L1 WASM:', digest);
