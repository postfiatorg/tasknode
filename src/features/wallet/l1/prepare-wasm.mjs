// Prepare only checksum-verified wallet package files. The bundled package is
// the clean-checkout fallback; the orchestrator can supply a rebuilt package.
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const PACKAGE_FILES = ['postfiat_wallet_wasm.js', 'postfiat_wallet_wasm.d.ts', 'postfiat_wallet_wasm_bg.wasm', 'postfiat_wallet_wasm_bg.wasm.d.ts', 'package.json'];
export const BUNDLED_DIRECTORY = fileURLToPath(new URL('./wasm/', import.meta.url));
export const COORDINATED_DIRECTORY = '/home/postfiat/repos/b23-coord/artifacts/wallet-wasm';
export async function selectWasmDirectory({ argument, env = process.env, coordinatedDirectory = COORDINATED_DIRECTORY, bundledDirectory = BUNDLED_DIRECTORY } = {}) {
  if (argument || env.B23_WALLET_WASM_DIR) return path.resolve(argument || env.B23_WALLET_WASM_DIR);
  try { await access(path.join(coordinatedDirectory, 'SHA256SUMS')); return coordinatedDirectory; }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Coordinated WASM manifest unavailable'); }
  return bundledDirectory;
}
export async function prepareWasm(sourceDirectory, destinationDirectory = BUNDLED_DIRECTORY) {
  if (!(await stat(sourceDirectory)).isDirectory()) throw new Error('Provide a wallet package directory containing SHA256SUMS');
  const manifest = await readFile(path.join(sourceDirectory, 'SHA256SUMS'), 'utf8');
  const entries = new Map();
  for (const line of manifest.split(/\r?\n/).filter(line => line.trim())) {
    const match = line.match(/^([0-9a-fA-F]{64}) [ *](.+)$/);
    if (!match) throw new Error('Invalid SHA256SUMS entry');
    const filename = match[2].replace(/^\.\//, '');
    const basename = filename.startsWith('pkg/') ? filename.slice(4) : filename;
    if (!PACKAGE_FILES.includes(basename)) continue;
    if (entries.has(basename)) throw new Error('Duplicate wallet package checksum');
    entries.set(basename, { filename, digest: match[1].toLowerCase() });
  }
  const verified = new Map();
  for (const name of PACKAGE_FILES) {
    const entry = entries.get(name);
    if (!entry) throw new Error(`Missing checksum for ${name}`);
    const bytes = await readFile(path.join(sourceDirectory, entry.filename));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== entry.digest) throw new Error(`Wallet package checksum mismatch: ${name}`);
    verified.set(name, bytes);
  }
  if (verified.get('postfiat_wallet_wasm_bg.wasm').subarray(0, 4).toString('hex') !== '0061736d') throw new Error('Invalid WASM artifact');
  const packageInfo = JSON.parse(verified.get('package.json').toString('utf8'));
  if (packageInfo.name !== 'postfiat-wallet-wasm' || packageInfo.type !== 'module') throw new Error('Invalid wallet package metadata');
  // Validate every file before replacing any destination file.
  await mkdir(destinationDirectory, { recursive: true });
  for (const [name, bytes] of verified) {
    const destination = path.join(destinationDirectory, name);
    const temporary = `${destination}.prepare-${process.pid}`;
    await writeFile(temporary, bytes);
    await rename(temporary, destination);
  }
  const normalizedManifest = PACKAGE_FILES.map(name => `${entries.get(name).digest}  ${name}\n`).join('');
  await writeFile(path.join(destinationDirectory, 'SHA256SUMS'), normalizedManifest);
  return { sourceDirectory, wasmSha256: entries.get('postfiat_wallet_wasm_bg.wasm').digest, verifiedFiles: verified.size };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const source = await selectWasmDirectory({ argument: process.argv[2] });
  console.log(JSON.stringify(await prepareWasm(source)));
}
