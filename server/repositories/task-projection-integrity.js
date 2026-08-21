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
