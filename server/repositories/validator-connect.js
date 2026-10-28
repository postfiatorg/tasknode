import { createHash, randomBytes, randomUUID } from "node:crypto";
import { query, transaction } from "../db/pool.js";
import { createValidatorChallenge, validatorError } from "../validator-identity.js";
import { bindValidator } from "./validator-bindings.js";

function tokenHash(token) {
  if (typeof token !== "string" || token.length !== 68 || !token.startsWith("vct_") ||
      ![...token.slice(4)].every(c => "0123456789abcdef".includes(c))) {
    throw validatorError("validator_connect_invalid_or_expired", 403);
  }
  return createHash("sha256").update(token).digest("hex");
}

export async function issueValidatorConnect(accountId) {
  const token = `vct_${randomBytes(32).toString("hex")}`;
  const id = `vc_${randomUUID()}`;
  const challenge = createValidatorChallenge(accountId);
  await transaction(async client => {
    await client.query(`INSERT INTO validator_challenges(challenge,account_id,expires_at) VALUES($1,$2,$3)`,
      [challenge.challenge, accountId, challenge.expiresAt]);
    await client.query(`INSERT INTO validator_connect_tokens(id,token_hash,account_id,challenge,expires_at) VALUES($1,$2,$3,$4,$5)`,
      [id, tokenHash(token), accountId, challenge.challenge, challenge.expiresAt]);
  });
  return { id, token, expiresAt: challenge.expiresAt };
}

async function pendingToken(token, accountId) {
  const row = (await query(`SELECT * FROM validator_connect_tokens
    WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now()`, [tokenHash(token)])).rows[0];
  if (!row || (accountId && row.account_id !== accountId)) throw validatorError("validator_connect_invalid_or_expired", 403);
  return row;
}

export async function validatorConnectChallenge(token, accountId) {
  const row = await pendingToken(token, accountId);
  return { challenge: row.challenge, expiresAt: row.expires_at };
}

export async function finishValidatorConnect({ token, masterPublicKey, signingPublicKey, manifest, signature, accountId, network, validatorId, mlDsaPublicKey }, { lookup, registryOptions } = {}) {
  const row = await pendingToken(token, accountId);
  const binding = await bindValidator({ accountId: row.account_id, challenge: row.challenge, masterPublicKey, signingPublicKey, manifest, signature, network, validatorId, mlDsaPublicKey }, {
    lookup, registryOptions, allowExisting: true,
    consume: async client => {
      const consumed = await client.query(`UPDATE validator_connect_tokens SET consumed_at=now()
        WHERE id=$1 AND account_id=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING id`, [row.id, row.account_id]);
      if (!consumed.rowCount) throw validatorError("validator_connect_invalid_or_expired", 403);
    },
    onBound: (client, connected) => client.query("UPDATE validator_connect_tokens SET binding_id=$2,proof=$3::jsonb WHERE id=$1", [row.id, connected.id, JSON.stringify({ masterPublicKey, signingPublicKey, manifest, signature, network: connected.network, validatorId, mlDsaPublicKey })]),
  });
  return binding;
}

export async function validatorConnectStatus(accountId, id) {
  const row = (await query(`SELECT id,expires_at,consumed_at,binding_id FROM validator_connect_tokens
    WHERE id=$1 AND account_id=$2`, [id, accountId])).rows[0];
  if (!row) throw validatorError("validator_connect_not_found", 404);
  return { id: row.id, status: row.binding_id ? "connected" : new Date(row.expires_at).getTime() <= Date.now() ? "expired" : "waiting",
    expiresAt: row.expires_at, bindingId: row.binding_id };
}
