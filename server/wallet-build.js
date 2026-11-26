import { readFileSync } from 'node:fs';

// prod and docker-dev are environment names reused across releases. Vite writes the exact
// bundle ID beside the page so the API serving that page checks the same value.
export function walletBuildId(env = process.env) {
  try { return readFileSync(new URL('../dist/wallet-build.txt', import.meta.url), 'utf8').trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return env.VITE_BUILD_ID || env.BUILD_ID || 'dev';
  }
}
