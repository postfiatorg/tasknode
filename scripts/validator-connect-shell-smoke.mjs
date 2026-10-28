import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(path.join(tmpdir(), "validator-connect-shell-"));
const script = path.resolve("public/validator.sh");
const key = `nH${"a".repeat(48)}`;
const signingKey = `n9${"b".repeat(48)}`;
const secret = "SYNTHETIC-PRIVATE-KEY-MUST-NEVER-LEAVE-THE-FILE";
const keyfile = path.join(dir, "key with spaces.json");
writeFileSync(keyfile, JSON.stringify({ public_key: key, secret_key: secret, token: "SYNTHETIC-VALIDATOR-TOKEN" }), { mode: 0o600 });
const mock = `#!${process.execPath}
const fs = require('node:fs'); const cp = require('node:child_process');
const args = process.argv.slice(2); const fixture = process.env.CONNECT_FIXTURE;
const mode = process.env.CONNECT_MODE; const log = process.env.CONNECT_LOG;
const tool = process.argv[1].split('/').pop();
if (tool === 'docker') {
 fs.appendFileSync(log, JSON.stringify({tool,args})+'\\n');
 if (args[0]==='inspect') {
  console.log(args.includes('{{.Image}}')?'sha256:fixture':args.some(x=>x.includes('.Args'))?'--conf\\n/custom config/postfiatd.cfg':'true');process.exit(0);
 }
 if (args[0]==='exec' && args[2]==='postfiatd') {console.log(JSON.stringify({result:{info:mode==='nonvalidator'?{}:{pubkey_validator:'${key}'}}}));process.exit(0);}
 if (args[0]==='exec' && args[2]==='stat') {console.log('1000:1000');process.exit(0);}
 if (args[0]==='exec' && args[2]==='awk') {if(mode==='missing')process.exit(1);const r=cp.spawnSync('awk',[...args.slice(3,-1),fixture],{encoding:'utf8'});process.stdout.write(r.stdout);process.exit(r.status);}
 if (args[0]==='run') {
  if(!args.includes('none') || !args.includes('--read-only') || !args.includes('--cap-drop') || !args.includes('core=0') || !args.includes('--log-driver'))process.exit(2);
  if(args.includes('python3')) {
   const helper=fs.readFileSync(0,'utf8');if(!helper.includes('validation_secret_key'))process.exit(5);
   if(mode==='notoken')process.exit(1);
   console.log(JSON.stringify({master_public_key:'${key}',signing_public_key:'${signingKey}',signature:'AB'.repeat(64),manifest:'cHVibGljLW1hbmlmZXN0'}));
  } else {if(fs.readFileSync(0,'utf8').length)process.exit(7);console.log(mode==='bad-signature'?'invalid':'AB'.repeat(64));}
  process.exit(0);
 }
 process.exit(3);
}
if (tool==='curl') {
 const body=fs.readFileSync(0,'utf8');fs.appendFileSync(log,JSON.stringify({tool,args,body})+'\\n');
 const url=args.at(-1);if(!url.startsWith('https://tasknode.postfiat.org/api/validators/connect/'))process.exit(4);
 if(url.endsWith('/challenge'))console.log(JSON.stringify(mode==='expired'?{error:'validator_connect_invalid_or_expired'}:{challenge:'pf-tasknode:fixture:account-one:1900000000'}));
 else console.log(JSON.stringify(mode==='stale'?{error:'validator_signing_key_not_current'}:{message:'Validator connected: ${key} (devnet), agreement 99.998% over 30 days'}));
}
`;
for (const tool of ["docker", "curl"]) writeFileSync(path.join(dir, tool), mock, { mode: 0o700 });
function run(mode, argv = []) {
  const log = path.join(dir, `${mode}.jsonl`); writeFileSync(log, "");
  const r = spawnSync("sh", ["-s", "--", `vct_${"a".repeat(64)}`, ...argv], { input: readFileSync(script, "utf8"), encoding: "utf8", env: { ...process.env,
    PATH: `${dir}:${process.env.PATH}`, CONNECT_FIXTURE: keyfile, CONNECT_MODE: mode, CONNECT_LOG: log } });
  const trace = readFileSync(log, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  for (const value of [r.stdout, r.stderr, JSON.stringify(trace)]) {
    assert.ok(!value.includes(secret)); assert.ok(!value.includes("SYNTHETIC-VALIDATOR-TOKEN"));
  }
  return { ...r, trace };
}
try {
  assert.equal(spawnSync("sh", ["-n", script]).status, 0);
  assert.equal(spawnSync("sh", [script, "--help"]).status, 0);
  const container = run("container"); assert.equal(container.status, 0, container.stderr);
  assert.ok(container.stdout.startsWith("Validator connected:"));
  assert.equal(container.trace.filter(x => x.tool === "curl").length, 2);
  const submitted = JSON.parse(container.trace.find(x => x.tool === "curl" && x.args.at(-1).endsWith("/complete")).body);
  assert.deepEqual(Object.keys(submitted).sort(), ["manifest", "master_public_key", "signature", "signing_public_key", "token"]);
  assert.equal(submitted.master_public_key, key); assert.equal(submitted.signing_public_key, signingKey);
  assert.ok(container.trace.some(x => x.args.includes('/custom config/postfiatd.cfg') && x.args.includes('server_info')));
  assert.ok(!container.trace.some(x => x.args.some(a => a.includes('validator-keys.json'))), "default never searches master files");
  const signing = container.trace.find(x => x.args[0] === "run");
  assert.ok(signing.args.includes("postfiatd:ro")); assert.ok(signing.args.includes("python3"));
  const host = run("host", ["--keyfile", keyfile]); assert.equal(host.status, 0, host.stderr);
  assert.ok(host.trace.some(x => x.args.includes(`${keyfile}:/run/tasknode-input:ro`)));
  const override = run("explicit-container", ["--keyfile", "/explicit/validator-keys.json"]); assert.equal(override.status, 0, override.stderr);
  assert.ok(override.trace.some(x => x.args[0] === "run" && x.args.includes("/usr/local/bin/validator-keys")));
  const missing = run("missing", ["--keyfile", path.join(dir, "absent.json")]); assert.notEqual(missing.status, 0);
  assert.equal(missing.trace.filter(x => x.tool === "curl").length, 0);
  const nonvalidator = run("nonvalidator"); assert.notEqual(nonvalidator.status, 0);
  assert.equal(nonvalidator.trace.filter(x => x.tool === "curl").length, 0);
  for (const mode of ["expired", "notoken"]) {
    const r = run(mode); assert.notEqual(r.status, 0); assert.equal(r.trace.filter(x => x.tool === "curl").length, 1);
  }
  const expired = run("expired"); assert.ok(!expired.trace.some(x => x.args[0] === "run"));
  const bad = run("bad-signature", ["--keyfile", keyfile]); assert.notEqual(bad.status, 0);
  assert.equal(bad.trace.filter(x => x.tool === "curl").length, 1);
  const stale = run("stale"); assert.notEqual(stale.status, 0); assert.ok(stale.stderr.includes("validator_signing_key_not_current"));
  console.log("validator-connect-shell-smoke ok: default token proof, custom running config, offline/read-only/no-log signer, explicit master overrides only, secret non-disclosure, absent token/nonvalidator/expiry/stale-key errors");
} finally { rmSync(dir, { recursive: true, force: true }); }
