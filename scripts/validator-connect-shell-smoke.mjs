import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(path.join(tmpdir(), "validator-connect-shell-"));
const script = path.resolve("public/validator.sh");
const key = `nH${"a".repeat(48)}`;
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
 if (args[0]==='inspect') { console.log(args.includes('{{.Image}}')?'sha256:fixture':'true'); process.exit(0); }
 if (args[0]==='exec' && args[2]==='test') process.exit(mode==='container'||mode==='expired'||mode==='bad-signature'?0:1);
 if (args[0]==='exec' && args[2]==='awk') {const r=cp.spawnSync('awk',[...args.slice(3,-1),fixture],{encoding:'utf8'});process.stdout.write(r.stdout);process.exit(r.status);}
 if ((args[0]==='exec' && args[2]==='validator-keys') || args[0]==='run') {
  if(args[0]==='run' && (!args.includes('none') || !args.some(x=>x.endsWith(':/keys/validator-keys.json:ro'))))process.exit(2);
  console.log(mode==='bad-signature'?'invalid': 'AB'.repeat(64)); process.exit(0);
 }
 process.exit(3);
}
if (tool==='curl') {
 const body=fs.readFileSync(0,'utf8');fs.appendFileSync(log,JSON.stringify({tool,args,body})+'\\n');
 const url=args.at(-1);if(!url.startsWith('https://tasknode.postfiat.org/api/validators/connect/'))process.exit(4);
 if(url.endsWith('/challenge'))console.log(JSON.stringify(mode==='expired'?{error:'validator_connect_invalid_or_expired'}:{challenge:'pf-tasknode:fixture:account-one:1900000000'}));
 else console.log(JSON.stringify({message:'Validator connected: ${key} (devnet), agreement 99.998% over 30 days'}));
}
`;
for (const tool of ["docker", "curl"]) writeFileSync(path.join(dir, tool), mock, { mode: 0o700 });
function run(mode, argv = []) {
  const log = path.join(dir, `${mode}.jsonl`); writeFileSync(log, "");
  const r = spawnSync("sh", [script, `vct_${"a".repeat(64)}`, ...argv], { encoding: "utf8", env: { ...process.env,
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
  assert.deepEqual(Object.keys(submitted).sort(), ["master_public_key", "signature", "token"]);
  assert.equal(submitted.master_public_key, key);
  const host = run("host", ["--keyfile", keyfile]); assert.equal(host.status, 0, host.stderr);
  assert.ok(host.trace.some(x => x.tool === "docker" && x.args[0] === "run" && x.args.includes("--network") && x.args.includes("none")));
  assert.ok(host.trace.some(x => x.tool === "docker" && x.args.includes(`${keyfile}:/keys/validator-keys.json:ro`)));
  const missing = run("missing", ["--keyfile", path.join(dir, "absent.json")]); assert.notEqual(missing.status, 0);
  assert.equal(missing.trace.filter(x => x.tool === "curl").length, 0);
  const expired = run("expired"); assert.notEqual(expired.status, 0);
  assert.equal(expired.trace.filter(x => x.tool === "curl").length, 1);
  assert.ok(!expired.trace.some(x => x.args.includes("sign")));
  const bad = run("bad-signature"); assert.notEqual(bad.status, 0);
  assert.equal(bad.trace.filter(x => x.tool === "curl").length, 1);
  console.log("validator-connect-shell-smoke ok: POSIX syntax, container autodiscovery, host override with spaces, read-only/offline signing, secret non-disclosure, missing-key/expiry/invalid-signature errors");
} finally { rmSync(dir, { recursive: true, force: true }); }
