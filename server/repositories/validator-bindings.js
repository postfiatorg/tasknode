import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import { createValidatorChallenge, findRegisteredValidator, validatorError, verifyRegisteredValidatorProof } from "../validator-identity.js";
import { L1_NETWORK, verifyRegisteredL1Proof } from "../l1-validator-identity.js";

const bindingFields = "id, account_id, master_public_key, network, bound_at, chain_id, validator_id, ml_dsa_public_key";

export async function listValidatorBindings(accountId) {
  if (!databaseEnabled()) return [];
  return (await query(`SELECT ${bindingFields} FROM validator_bindings
    WHERE account_id=$1 AND revoked_at IS NULL ORDER BY bound_at`, [accountId])).rows;
}

export async function hasValidatorBinding(accountId) {
  return Boolean(accountId && (await listValidatorBindings(accountId)).length);
}

export async function issueValidatorChallenge(accountId) {
  const value = createValidatorChallenge(accountId);
  await query(`INSERT INTO validator_challenges(challenge,account_id,expires_at) VALUES($1,$2,$3)`,
    [value.challenge, accountId, value.expiresAt]);
  return { ...value, signCommand: `docker exec postfiatd validator-keys --keyfile /root/.ripple/validator-keys.json sign "${value.challenge}"` };
}

export async function bindValidator({ accountId, masterPublicKey, signingPublicKey, manifest, signature, challenge, network, validatorId, mlDsaPublicKey }, { lookup = findRegisteredValidator, registryOptions, consume, onBound, allowExisting = false } = {}) {
  const proof = await query(`SELECT 1 FROM validator_challenges WHERE challenge=$1 AND account_id=$2
    AND consumed_at IS NULL AND expires_at>now()`, [challenge, accountId]);
  if (!proof.rowCount) throw validatorError("validator_challenge_invalid_or_expired", 403);
  const l1 = network === L1_NETWORK;
  if ((l1 && [masterPublicKey, signingPublicKey, manifest].some(value => value !== undefined)) ||
      (!l1 && [network, validatorId, mlDsaPublicKey].some(value => value !== undefined))) {
    throw validatorError("validator_proof_network_invalid", 400);
  }
  const registered = l1
    ? await verifyRegisteredL1Proof({ validatorId, publicKey: mlDsaPublicKey, signature, challenge }, registryOptions)
    : await verifyRegisteredValidatorProof({ masterPublicKey, signingPublicKey, manifest, signature, challenge }, lookup);
  try {
    return await transaction(async (client) => {
      const consumed = await client.query(`UPDATE validator_challenges SET consumed_at=now()
        WHERE challenge=$1 AND account_id=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING challenge`, [challenge, accountId]);
      if (!consumed.rowCount) throw validatorError("validator_challenge_invalid_or_expired", 403);
      if (consume) await consume(client);
      if (allowExisting) {
        const existing = (await client.query(`SELECT ${bindingFields} FROM validator_bindings
          WHERE revoked_at IS NULL AND ${l1 ? "network=$1 AND ((chain_id=$2 AND validator_id=$3) OR ml_dsa_public_key=$4)" : "master_public_key=$1"}`,
        l1 ? [L1_NETWORK, registered.chainId, validatorId, mlDsaPublicKey] : [masterPublicKey])).rows[0];
        if (existing) {
          if (existing.account_id !== accountId || (l1 && (existing.validator_id !== validatorId || existing.ml_dsa_public_key !== mlDsaPublicKey))) {
            throw validatorError("validator_already_bound", 409);
          }
          if (onBound) await onBound(client, existing);
          return existing;
        }
      }
      const result = await client.query(`INSERT INTO validator_bindings(id,account_id,master_public_key,network,signature,challenge,signing_public_key,manifest,chain_id,validator_id,ml_dsa_public_key,registry_evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING ${bindingFields}`,
      [`vb_${randomUUID()}`, accountId, masterPublicKey || null, registered.network, signature, challenge, signingPublicKey || null, manifest || null,
        registered.chainId || null, validatorId || null, mlDsaPublicKey || null, l1 ? JSON.stringify(registered.registryEvidence) : null]);
      if (onBound) await onBound(client, result.rows[0]);
      return result.rows[0];
    });
  } catch (error) {
    if (error.code === "23505") throw validatorError("validator_already_bound", 409);
    throw error;
  }
}

export async function revokeValidatorBinding(accountId, id) {
  return transaction(async (client) => {
    const result = await client.query(`UPDATE validator_bindings SET revoked_at=now()
      WHERE account_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id`, [accountId, id]);
    // Existing viewer tokens must not survive an unbind/rebind cycle.
    await client.query(`UPDATE index_viewer_tokens SET revoked_at=now() WHERE account_id=$1 AND revoked_at IS NULL
      AND index_id IN (SELECT index_id FROM index_viewer_indices WHERE tier='validator')`, [accountId]);
    await client.query(`UPDATE research_api_keys SET revoked_at=now() WHERE account_id=$1 AND revoked_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM validator_bindings WHERE account_id=$1 AND revoked_at IS NULL)`, [accountId]);
    return result.rowCount > 0;
  });
}
