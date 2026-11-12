// First-party source: postfiatl1v2 wallet-web/src/wasm. No binaries in git.
import { copyFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const source = process.argv[2];
if (!source) throw new Error('Usage: node src/features/wallet/l1/prepare-wasm.mjs /path/to/postfiat_wallet_wasm_bg.wasm');
const bytes = await readFile(source);
if (bytes.subarray(0, 4).toString('hex') !== '0061736d') throw new Error('Not a WASM artifact');
await copyFile(source, new URL('./wasm/postfiat_wallet_wasm_bg.wasm', import.meta.url));
console.log('Prepared L1 WASM:', createHash('sha256').update(bytes).digest('hex'));
