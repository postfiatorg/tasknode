import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import { createValidatorChallenge, findRegisteredValidator, validatorError, verifyValidatorSignature } from "../validator-identity.js";

export async function listValidatorBindings(accountId) {
  if (!databaseEnabled()) return [];
  return (await query(`SELECT id, account_id, master_public_key, network, bound_at FROM validator_bindings
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

export async function bindValidator({ accountId, masterPublicKey, signature, challenge }, { lookup = findRegisteredValidator, consume, onBound, allowExisting = false } = {}) {
  const proof = await query(`SELECT 1 FROM validator_challenges WHERE challenge=$1 AND account_id=$2
    AND consumed_at IS NULL AND expires_at>now()`, [challenge, accountId]);
  if (!proof.rowCount) throw validatorError("validator_challenge_invalid_or_expired", 403);
  if (!verifyValidatorSignature({ masterPublicKey, signature, challenge })) throw validatorError("validator_signature_invalid", 403);
  const registered = await lookup(masterPublicKey);
  try {
    return await transaction(async (client) => {
      const consumed = await client.query(`UPDATE validator_challenges SET consumed_at=now()
        WHERE challenge=$1 AND account_id=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING challenge`, [challenge, accountId]);
      if (!consumed.rowCount) throw validatorError("validator_challenge_invalid_or_expired", 403);
      if (consume) await consume(client);
      if (allowExisting) {
        const existing = (await client.query(`SELECT id,account_id,master_public_key,network,bound_at FROM validator_bindings
          WHERE master_public_key=$1 AND revoked_at IS NULL`, [masterPublicKey])).rows[0];
        if (existing) {
          if (existing.account_id !== accountId) throw validatorError("validator_already_bound", 409);
          if (onBound) await onBound(client, existing);
          return existing;
        }
      }
      const result = await client.query(`INSERT INTO validator_bindings(id,account_id,master_public_key,network,signature,challenge)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id,account_id,master_public_key,network,bound_at`,
      [`vb_${randomUUID()}`, accountId, masterPublicKey, registered.network, signature, challenge]);
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
