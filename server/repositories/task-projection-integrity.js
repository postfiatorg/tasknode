export function nonFixtureTaskProjectionSql(alias = "p") {
  return `COALESCE(${alias}.source, '') <> 'directory_polish_local_fixture'
    AND COALESCE(${alias}.metadata_json->>'directoryPolishFixture', 'false') <> 'true'
    AND ${alias}.task_id NOT LIKE 'directory_polish_%'
    AND ${alias}.task_id NOT LIKE 'task_cancel_paid_%'`;
}

export function canonicalRewardedTaskProjectionSql(alias = "p") {
  return `${nonFixtureTaskProjectionSql(alias)}
    AND ${alias}.reward_actual_pft > 0
    AND COALESCE(${alias}.event_count, 0) > 0
    AND COALESCE(${alias}.last_event_tx_hash, '') <> ''
    AND COALESCE(${alias}.last_event_cid, '') <> ''`;
}

export function nonFixtureRecommendedProfileSql(alias = "profile") {
  return `COALESCE(${alias}.packet_json->>'directoryPolishFixture', 'false') <> 'true'
    AND COALESCE(${alias}.packet_digest, '') NOT LIKE 'directory_polish_%'
    AND COALESCE(${alias}.network_profile_id, '') NOT LIKE 'directory_polish_%'
    AND COALESCE(${alias}.network_profile_digest, '') NOT LIKE 'directory_polish_%'
    AND COALESCE(${alias}.embedding_model, '') <> 'directory-polish-local'`;
}

export function nonFixtureProfileNftSql(alias = "nft") {
  return `COALESCE(${alias}.metadata_json->>'directoryPolishFixture', 'false') <> 'true'
    AND ${alias}.id NOT LIKE 'directory_polish_%'
    AND COALESCE(${alias}.model, '') <> 'directory-polish'`;
}

export function nonFixtureAirdropRunSql(alias = "run") {
  return `${alias}.id NOT LIKE 'directory_polish_%'
    AND COALESCE(${alias}.input_hash, '') NOT LIKE 'directory_polish_%'
    AND COALESCE(${alias}.input_snapshot->>'directoryPolishFixture', 'false') <> 'true'
    AND COALESCE(${alias}.output_json->>'directoryPolishFixture', 'false') <> 'true'
    AND COALESCE(${alias}.model, '') <> 'directory-polish'
    AND COALESCE(${alias}.prompt_version, '') <> 'local-only'`;
}
// A failed hydration attempt is historical once this exact owned event has
// already reached the event store and the projection includes that event or a
// later recorded event in the same owned task history.
export function unappliedTaskReducerFailureSql(alias = "r") {
  return `${alias}.status = 'failed' AND NOT EXISTS (
    SELECT 1 FROM task_projections applied
    JOIN task_events recorded ON recorded.task_id=applied.task_id
      AND recorded.account_id=applied.account_id AND recorded.wallet_address=applied.subject_wallet
    WHERE applied.task_id=${alias}.task_id AND applied.account_id=${alias}.account_id
      AND applied.subject_wallet=${alias}.wallet_address AND applied.event_count>0
      AND ${alias}.tx_hash<>'' AND COALESCE(${alias}.cid,'')<>''
      AND recorded.source_tx_hash=${alias}.tx_hash AND recorded.source_cid=${alias}.cid
      AND (
        (applied.last_event_tx_hash=${alias}.tx_hash AND applied.last_event_cid=${alias}.cid)
        OR (applied.event_count>1 AND EXISTS (
          SELECT 1 FROM task_events head
          WHERE head.task_id=applied.task_id AND head.account_id=applied.account_id
            AND head.wallet_address=applied.subject_wallet
            AND head.source_tx_hash=applied.last_event_tx_hash
            AND head.source_cid=applied.last_event_cid
            AND head.occurred_at>recorded.occurred_at
        ))
      )
  )`;
}

// Reward rejection is terminal but is not completed work. Explicit completed
// projections and successful paid/partially paid rewards qualify.
export function completedTaskProjectionSql(alias = "p") {
  return `(${alias}.status = 'completed' OR (${alias}.status = 'rewarded' AND ${alias}.reward_actual_pft > 0))`;
}
