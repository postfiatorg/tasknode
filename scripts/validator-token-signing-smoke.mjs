import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { encodeNodePublic } from "ripple-address-codec";
import { encode } from "ripple-binary-codec";
import { verifyRegisteredValidatorProof, verifyValidatorManifest, verifyValidatorSignature, findRegisteredValidator } from "../server/validator-identity.js";

const script = readFileSync("public/validator.sh", "utf8");
const helper = script.split("<<'PY'\n")[1].split("\nPY\n")[0];
async function testAlgorithms(masterAlgorithm, signingAlgorithm) {
  const dir = mkdtempSync(path.join(tmpdir(), "validator-token-signing-"));
  const nodePublic = key => encodeNodePublic(Buffer.from(key.publicKey, "hex"));
  const master = deriveKeypair(generateSeed({ algorithm: masterAlgorithm }));
  const signing = deriveKeypair(generateSeed({ algorithm: signingAlgorithm }));
  const stale = deriveKeypair(generateSeed({ algorithm: signingAlgorithm }));
  const masterPublicKey = nodePublic(master), signingPublicKey = nodePublic(signing);
  const challenge = "pf-tasknode:synthetic-d51:fixture-account:1900000000";
  function manifestFor(key = signing, options = {}) {
    const fields = { Sequence: 2, PublicKey: master.publicKey, SigningPubKey: key.publicKey, ...options };
    const payload = `4D414E00${encode(fields)}`;
    return Buffer.from(encode({ ...fields, Signature: sign(payload, key.privateKey), MasterSignature: sign(payload, master.privateKey) }), "hex").toString("base64");
  }
  const manifest = manifestFor();
  const fixtureToken = Buffer.from(JSON.stringify({ validation_secret_key: signing.privateKey.slice(-64), manifest })).toString("base64");
  const config = path.join(dir, "postfiatd.cfg");
  writeFileSync(config, `[server]\nport_rpc_admin_local\n[validator_token]\n# synthetic fixture only\n${fixtureToken.slice(0, 80)}\n${fixtureToken.slice(80)}\n[other]\nignored\n`, { mode: process.env.VALIDATOR_SIGNING_TEST_USER === "0:0" ? 0o644 : 0o600 });
  const image = process.env.VALIDATOR_SIGNING_TEST_IMAGE;
  const containerUser = process.env.VALIDATOR_SIGNING_TEST_USER || `${process.getuid()}:${process.getgid()}`;
  function run(input = config, diagnose = "0") {
    const r = image
      ? spawnSync("docker", ["run", "--rm", "-i", "--user", containerUser, "--network", "none", "--read-only", "--log-driver", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--ulimit", "core=0", "-v", `${input}:/fixture.cfg:ro`, "--entrypoint", "python3", image, "-", "/fixture.cfg", masterPublicKey, challenge, diagnose], { input: helper, encoding: "utf8" })
      : spawnSync("python3", ["-", input, masterPublicKey, challenge, diagnose], { input: helper, encoding: "utf8" });
    for (const output of [r.stdout, r.stderr]) {
      assert.ok(!output.includes(fixtureToken)); assert.ok(!output.includes(signing.privateKey.slice(-64)));
      assert.ok(!output.includes("Traceback"));
    }
    return r;
  }
  try {
    const r = run(config, "1"); assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(`derive_${signingAlgorithm === "ed25519" ? "ed25519" : "secp256k1"}_public_key`));
    assert.ok(r.stderr.includes("public_proof_ready"));
    const publicProof = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(publicProof).sort(), ["manifest", "master_public_key", "signature", "signing_public_key"]);
    assert.equal(publicProof.signing_public_key, signingPublicKey);
    const proof = { masterPublicKey, signingPublicKey, signature: publicProof.signature, challenge, manifest };
    const lookup = async () => ({ network: "testnet", masterPublicKey, signingPublicKey });
    assert.equal(verifyValidatorSignature({ masterPublicKey: signingPublicKey, signature: proof.signature, challenge }), true);
    assert.equal(verifyValidatorManifest(proof), true);
    assert.equal((await verifyRegisteredValidatorProof(proof, lookup)).network, "testnet");
    await assert.rejects(verifyRegisteredValidatorProof({ ...proof, challenge: `${challenge}changed` }, lookup), /signature_invalid/);
    await assert.rejects(verifyRegisteredValidatorProof({ ...proof, signingPublicKey: nodePublic(stale) }, lookup), /signature_invalid/);
    const staleProof = { ...proof, signingPublicKey: nodePublic(stale), signature: sign(Buffer.from(challenge).toString("hex"), stale.privateKey), manifest: manifestFor(stale) };
    await assert.rejects(verifyRegisteredValidatorProof(staleProof, lookup), /signing_key_not_current/);
    await assert.rejects(verifyRegisteredValidatorProof(proof, async () => ({ network: "testnet" })), /signing_key_not_current/);
    await assert.rejects(verifyRegisteredValidatorProof({ ...proof, manifest: manifestFor(stale) }, lookup), /manifest_invalid/);
    await assert.rejects(verifyRegisteredValidatorProof({ ...proof, manifest: manifestFor(signing, { Sequence: 0xffffffff }) }, lookup), /manifest_invalid/);
    await assert.rejects(verifyRegisteredValidatorProof({ ...proof, manifest: Buffer.from("junk").toString("base64") }, lookup), /manifest_invalid/);
    assert.equal(verifyValidatorManifest({ ...proof, masterPublicKey: nodePublic(stale) }), false);
    assert.equal((await verifyRegisteredValidatorProof({ ...proof, manifest: undefined }, lookup)).network, "testnet");
    const registered = await findRegisteredValidator(masterPublicKey, { fetchImpl: async () => new Response(JSON.stringify({ result: "success", validators: [{ master_key: masterPublicKey, signing_key: signingPublicKey, revoked: false }] })) });
    assert.equal(registered.signingPublicKey, signingPublicKey);
    const mismatchToken = Buffer.from(JSON.stringify({ validation_secret_key: stale.privateKey.slice(-64), manifest })).toString("base64");
    writeFileSync(config, `[validator_token]\n${mismatchToken}\n`);
    const mismatch = run(config, "1"); assert.notEqual(mismatch.status, 0); assert.ok(mismatch.stderr.includes("does not match"));
    assert.ok(!mismatch.stderr.includes(stale.privateKey.slice(-64)));
    writeFileSync(config, "[validator_token]\ninvalid-private-marker\n");
    const invalid = run(); assert.notEqual(invalid.status, 0); assert.ok(!invalid.stderr.includes("invalid-private-marker")); assert.ok(invalid.stderr.includes("token_decode"));
    writeFileSync(config, "[server]\nport_rpc_admin_local\n");
    const absent = run(); assert.notEqual(absent.status, 0); assert.ok(absent.stderr.includes("not configured"));
    const missing = run(path.join(dir, "missing.cfg"), "1"); assert.notEqual(missing.status, 0); assert.ok(missing.stderr.includes("config_read"));
    console.log(`validator-token-signing-smoke ok: master=${masterAlgorithm} signing=${signingAlgorithm}, ${image ? "real image offline" : "local OpenSSL"}, synthetic token -> valid signature, master-signed manifest, wrong/stale/missing signing key refused, revocation/malformed/foreign manifest refused, secret non-disclosure, missing/invalid config errors`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
for (const master of ["ed25519", "ecdsa-secp256k1"]) {
  for (const signing of ["ed25519", "ecdsa-secp256k1"]) await testAlgorithms(master, signing);
}
