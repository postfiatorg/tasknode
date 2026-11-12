import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PACKAGE_FILES, BUNDLED_DIRECTORY, selectWasmDirectory, prepareWasm } from './prepare-wasm.mjs';
const temporary=await mkdtemp('/home/postfiat/repos/b23-coord/evidence/wallet/wasm-test-');
const source=path.join(temporary,'source'),destination=path.join(temporary,'destination');
try {
 await mkdir(source);let manifest='';
 for(const name of PACKAGE_FILES){const bytes=await readFile(path.join(BUNDLED_DIRECTORY,name));await writeFile(path.join(source,name),bytes);manifest+=`${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`;}
 await writeFile(path.join(source,'SHA256SUMS'),manifest);
 assert.equal(await selectWasmDirectory({env:{},coordinatedDirectory:temporary+'/absent',bundledDirectory:source}),source);
 assert.equal(await selectWasmDirectory({env:{},coordinatedDirectory:source}),source);
 assert.equal(await selectWasmDirectory({env:{B23_WALLET_WASM_DIR:source}}),source);
 assert.equal(await selectWasmDirectory({argument:destination,env:{B23_WALLET_WASM_DIR:source}}),destination);
 const report=await prepareWasm(source,destination);assert.equal(report.verifiedFiles,5);
 const original=await readFile(path.join(destination,'postfiat_wallet_wasm.js'));
 await writeFile(path.join(source,'postfiat_wallet_wasm.js'),'tampered');await assert.rejects(prepareWasm(source,destination),/checksum mismatch/);
 assert.deepEqual(await readFile(path.join(destination,'postfiat_wallet_wasm.js')),original);
 await writeFile(path.join(source,'postfiat_wallet_wasm.js'),original);
 await writeFile(path.join(source,'SHA256SUMS'),manifest.split('\n').filter(line=>!line.endsWith('package.json')).join('\n'));await assert.rejects(prepareWasm(source,destination),/Missing checksum/);
 await writeFile(path.join(source,'SHA256SUMS'),manifest+manifest.split('\n')[0]+'\n');await assert.rejects(prepareWasm(source,destination),/Duplicate/);
 // A new package with a different hash qualifies from its manifest, not a built-in pin.
 const changed=Buffer.concat([original,Buffer.from('\n// qualified package fixture\n')]);await writeFile(path.join(source,'postfiat_wallet_wasm.js'),changed);
 manifest=manifest.replace(/^\w{64}(  postfiat_wallet_wasm.js)$/m,createHash('sha256').update(changed).digest('hex')+'$1');await writeFile(path.join(source,'SHA256SUMS'),manifest);await prepareWasm(source,destination);
 assert.deepEqual(await readFile(path.join(destination,'postfiat_wallet_wasm.js')),changed);
 const wasmName='postfiat_wallet_wasm_bg.wasm';
 const newWasm=Buffer.concat([await readFile(path.join(source,wasmName)),Buffer.from([0,1,0])]);
 assert.ok(WebAssembly.validate(newWasm));
 const newDigest=createHash('sha256').update(newWasm).digest('hex');await writeFile(path.join(source,wasmName),newWasm);
 manifest=manifest.replace(/^\w{64}(  postfiat_wallet_wasm_bg.wasm)$/m,newDigest+'$1');await writeFile(path.join(source,'SHA256SUMS'),manifest);
 assert.equal((await prepareWasm(source,destination)).wasmSha256,newDigest);
 console.log('PASS: bundled fallback, coordinated auto-selection, argument/env precedence, all five package files verified before writes, tamper/missing/duplicate rejection, updated package checksum accepted.');
}finally{await rm(temporary,{recursive:true,force:true});}
