CREATE TEMP TABLE tasknode_projection_fixture_cleanup_tasks ON COMMIT DROP AS
SELECT task_id
FROM task_projections
WHERE COALESCE(source, '') = 'directory_polish_local_fixture'
   OR COALESCE(metadata_json->>'directoryPolishFixture', 'false') = 'true'
   OR task_id LIKE 'directory_polish_%'
   OR COALESCE(source, '') = 'board_manager_cancel_network_task_smoke'
   OR task_id LIKE 'task_cancel_paid_%';

DELETE FROM pftl_pointer_observations
WHERE task_id IN (SELECT task_id FROM tasknode_projection_fixture_cleanup_tasks);

DELETE FROM pftl_task_pointer_events
WHERE task_id IN (SELECT task_id FROM tasknode_projection_fixture_cleanup_tasks);

DELETE FROM task_events
WHERE task_id IN (SELECT task_id FROM tasknode_projection_fixture_cleanup_tasks);

DELETE FROM task_review_publications
WHERE task_id IN (SELECT task_id FROM tasknode_projection_fixture_cleanup_tasks);

DELETE FROM network_project_task_refs
WHERE task_id IN (SELECT task_id FROM tasknode_projection_fixture_cleanup_tasks);

DELETE FROM network_task_generation_jobs
WHERE task_id IN (SELECT task_id FROM tasknode_projection_fixture_cleanup_tasks);

DELETE FROM network_task_allocations
WHERE generated_task_id IN (SELECT task_id FROM tasknode_projection_fixture_cleanup_tasks);

-- user_observability_events is append-heavy in production. Keep this cleanup
-- on indexed fields so boot-time migrations do not full-scan the observability
-- log looking for local-only fixture metadata.
DELETE FROM user_observability_events
WHERE wallet_address >= 'rDirQa' AND wallet_address < 'rDirQb';

DELETE FROM user_observability_events
WHERE task_id IN (SELECT task_id FROM tasknode_projection_fixture_cleanup_tasks);

DELETE FROM profile_public_snapshots
WHERE COALESCE(input_snapshot->>'directoryPolishFixture', 'false') = 'true'
   OR COALESCE(output_json->>'directoryPolishFixture', 'false') = 'true';

DELETE FROM network_task_profile_jobs
WHERE COALESCE(source_packet_json->>'directoryPolishFixture', 'false') = 'true'
   OR COALESCE(source_packet_text, '') ILIKE '%directory polish%';

DELETE FROM network_task_profiles
WHERE COALESCE(source_packet_json->>'directoryPolishFixture', 'false') = 'true'
   OR COALESCE(source_packet_text, '') ILIKE '%directory polish%';

DELETE FROM recommended_connection_profiles
WHERE COALESCE(packet_json->>'directoryPolishFixture', 'false') = 'true'
   OR COALESCE(packet_digest, '') LIKE 'directory_polish_%'
   OR COALESCE(network_profile_id, '') LIKE 'directory_polish_%'
   OR COALESCE(network_profile_digest, '') LIKE 'directory_polish_%'
   OR COALESCE(embedding_model, '') = 'directory-polish-local';

DELETE FROM profile_nfts
WHERE COALESCE(metadata_json->>'directoryPolishFixture', 'false') = 'true'
   OR id LIKE 'directory_polish_%'
   OR COALESCE(model, '') = 'directory-polish';

DELETE FROM profile_daily_airdrop_runs
WHERE id LIKE 'directory_polish_%'
   OR COALESCE(input_hash, '') LIKE 'directory_polish_%'
   OR COALESCE(input_snapshot->>'directoryPolishFixture', 'false') = 'true'
   OR COALESCE(output_json->>'directoryPolishFixture', 'false') = 'true'
   OR COALESCE(model, '') = 'directory-polish'
   OR COALESCE(prompt_version, '') = 'local-only';

DELETE FROM task_projections
WHERE task_id IN (SELECT task_id FROM tasknode_projection_fixture_cleanup_tasks);

DO $$
BEGIN
  IF to_regclass('public.orc_task_review_states') IS NOT NULL THEN
    EXECUTE 'DELETE FROM orc_task_review_states WHERE task_id IN (SELECT task_id FROM tasknode_projection_fixture_cleanup_tasks)';
  END IF;
END $$;

CREATE OR REPLACE VIEW user_task_behavior_rollups AS
SELECT
  account_id,
  subject_wallet AS wallet_address,
  COALESCE(NULLIF(task_kind, ''), 'unknown') AS task_kind,
  min(created_at) AS window_start,
  max(updated_at) AS window_end,
  count(*) FILTER (WHERE status IN ('proposed', 'accepted', 'submitted', 'verification_requested', 'verification_response_submitted', 'rewarded', 'refused', 'cancelled', 'rejected', 'expired'))::integer AS offered_count,
  count(*) FILTER (
    WHERE status IN ('accepted', 'submitted', 'verification_requested', 'verification_response_submitted')
       OR (
         status = 'rewarded'
         AND reward_actual_pft > 0
         AND COALESCE(event_count, 0) > 0
         AND COALESCE(last_event_tx_hash, '') <> ''
         AND COALESCE(last_event_cid, '') <> ''
       )
  )::integer AS accepted_count,
  count(*) FILTER (WHERE status = 'refused')::integer AS refused_count,
  count(*) FILTER (WHERE status = 'expired')::integer AS expired_count,
  count(*) FILTER (
    WHERE status IN ('submitted', 'verification_requested', 'verification_response_submitted')
       OR (
         status = 'rewarded'
         AND reward_actual_pft > 0
         AND COALESCE(event_count, 0) > 0
         AND COALESCE(last_event_tx_hash, '') <> ''
         AND COALESCE(last_event_cid, '') <> ''
       )
  )::integer AS submitted_count,
  count(*) FILTER (
    WHERE status = 'rewarded'
      AND reward_actual_pft > 0
      AND COALESCE(event_count, 0) > 0
      AND COALESCE(last_event_tx_hash, '') <> ''
      AND COALESCE(last_event_cid, '') <> ''
  )::integer AS rewarded_count,
  COALESCE(sum(reward_actual_pft) FILTER (
    WHERE reward_actual_pft > 0
      AND COALESCE(event_count, 0) > 0
      AND COALESCE(last_event_tx_hash, '') <> ''
      AND COALESCE(last_event_cid, '') <> ''
  ), 0)::numeric(18, 6) AS reward_pft,
  CASE
    WHEN count(*) FILTER (WHERE status IN ('proposed', 'accepted', 'submitted', 'verification_requested', 'verification_response_submitted', 'rewarded', 'refused', 'cancelled', 'rejected', 'expired')) = 0
      THEN 0::numeric
    ELSE (
      count(*) FILTER (WHERE status = 'refused')::numeric /
      count(*) FILTER (WHERE status IN ('proposed', 'accepted', 'submitted', 'verification_requested', 'verification_response_submitted', 'rewarded', 'refused', 'cancelled', 'rejected', 'expired'))::numeric
    )
  END AS refusal_rate
FROM task_projections
WHERE (account_id <> '' OR subject_wallet <> '')
  AND COALESCE(source, '') <> 'directory_polish_local_fixture'
  AND COALESCE(metadata_json->>'directoryPolishFixture', 'false') <> 'true'
  AND task_id NOT LIKE 'directory_polish_%'
  AND task_id NOT LIKE 'task_cancel_paid_%'
GROUP BY account_id, subject_wallet, COALESCE(NULLIF(task_kind, ''), 'unknown');

CREATE OR REPLACE VIEW user_reward_rollups AS
WITH task_rewards AS (
  SELECT
    account_id,
    subject_wallet AS wallet_address,
    updated_at::date AS day,
    COALESCE(sum(reward_actual_pft), 0)::numeric(18, 6) AS task_reward_pft,
    0::numeric(18, 6) AS daily_airdrop_pft,
    0::numeric(18, 6) AS initiation_grant_pft,
    0::numeric(18, 6) AS top_up_credit_usd
  FROM task_projections
  WHERE reward_actual_pft > 0
    AND COALESCE(event_count, 0) > 0
    AND COALESCE(last_event_tx_hash, '') <> ''
    AND COALESCE(last_event_cid, '') <> ''
    AND COALESCE(source, '') <> 'directory_polish_local_fixture'
    AND COALESCE(metadata_json->>'directoryPolishFixture', 'false') <> 'true'
    AND task_id NOT LIKE 'directory_polish_%'
    AND task_id NOT LIKE 'task_cancel_paid_%'
  GROUP BY account_id, subject_wallet, updated_at::date
),
airdrop_rewards AS (
  SELECT
    account_id,
    recipient_wallet AS wallet_address,
    COALESCE(submitted_at, updated_at, created_at)::date AS day,
    0::numeric(18, 6) AS task_reward_pft,
    COALESCE(sum(amount_pft) FILTER (WHERE status = 'submitted'), 0)::numeric(18, 6) AS daily_airdrop_pft,
    0::numeric(18, 6) AS initiation_grant_pft,
    0::numeric(18, 6) AS top_up_credit_usd
  FROM profile_daily_airdrop_issuances
  GROUP BY account_id, recipient_wallet, COALESCE(submitted_at, updated_at, created_at)::date
),
initiation_grants AS (
  SELECT
    account_id,
    wallet_address,
    updated_at::date AS day,
    0::numeric(18, 6) AS task_reward_pft,
    0::numeric(18, 6) AS daily_airdrop_pft,
    COALESCE(sum(amount_pft) FILTER (WHERE status IN ('completed', 'processing', 'unknown')), 0)::numeric(18, 6) AS initiation_grant_pft,
    0::numeric(18, 6) AS top_up_credit_usd
  FROM wallet_initiation_grants
  GROUP BY account_id, wallet_address, updated_at::date
),
credit_rewards AS (
  SELECT
    account_id,
    '' AS wallet_address,
    created_at::date AS day,
    0::numeric(18, 6) AS task_reward_pft,
    0::numeric(18, 6) AS daily_airdrop_pft,
    0::numeric(18, 6) AS initiation_grant_pft,
    COALESCE(sum(amount_usd) FILTER (WHERE amount_usd > 0), 0)::numeric(18, 6) AS top_up_credit_usd
  FROM billing_ledger_entries
  WHERE kind IN ('credit', 'top_up', 'deposit_credit', 'manual_credit')
  GROUP BY account_id, created_at::date
)
SELECT
  account_id,
  wallet_address,
  day,
  sum(task_reward_pft)::numeric(18, 6) AS task_reward_pft,
  sum(daily_airdrop_pft)::numeric(18, 6) AS daily_airdrop_pft,
  sum(initiation_grant_pft)::numeric(18, 6) AS initiation_grant_pft,
  sum(top_up_credit_usd)::numeric(18, 6) AS top_up_credit_usd
FROM (
  SELECT * FROM task_rewards
  UNION ALL
  SELECT * FROM airdrop_rewards
  UNION ALL
  SELECT * FROM initiation_grants
  UNION ALL
  SELECT * FROM credit_rewards
) AS rewards
GROUP BY account_id, wallet_address, day;

CREATE OR REPLACE VIEW user_identity_vectors AS
WITH non_fixture_task_projections AS (
  SELECT *
  FROM task_projections
  WHERE COALESCE(source, '') <> 'directory_polish_local_fixture'
    AND COALESCE(metadata_json->>'directoryPolishFixture', 'false') <> 'true'
    AND task_id NOT LIKE 'directory_polish_%'
    AND task_id NOT LIKE 'task_cancel_paid_%'
),
account_ids AS (
  SELECT DISTINCT account_id
  FROM pftl_sync_wallets
  WHERE COALESCE(account_id, '') <> ''
  UNION
  SELECT DISTINCT account_id
  FROM non_fixture_task_projections
  WHERE account_id <> ''
  UNION
  SELECT DISTINCT account_id
  FROM telegram_bot_events
  WHERE account_id <> ''
  UNION
  SELECT DISTINCT account_id
  FROM user_observability_events
  WHERE account_id <> ''
),
latest_handles AS (
  SELECT DISTINCT ON (account_id)
    account_id,
    public_handle,
    occurred_at AS updated_at
  FROM user_observability_events
  WHERE account_id <> ''
    AND public_handle <> ''
  ORDER BY account_id, occurred_at DESC, id DESC
),
wallet_rows AS (
  SELECT DISTINCT
    account_id,
    wallet_address,
    role,
    status,
    'pftl_sync_wallets' AS source,
    COALESCE(last_hot_sync_at, last_archive_sync_at, updated_at, created_at) AS last_seen_at
  FROM pftl_sync_wallets
  WHERE COALESCE(account_id, '') <> ''
    AND wallet_address <> ''
  UNION
  SELECT DISTINCT
    account_id,
    subject_wallet AS wallet_address,
    'user' AS role,
    'historical' AS status,
    'task_projections' AS source,
    max(updated_at) AS last_seen_at
  FROM non_fixture_task_projections
  WHERE account_id <> ''
    AND subject_wallet <> ''
  GROUP BY account_id, subject_wallet
  UNION
  SELECT DISTINCT
    account_id,
    wallet_address,
    'user' AS role,
    COALESCE(NULLIF(wallet_scope, ''), 'unknown') AS status,
    'user_observability_events' AS source,
    max(occurred_at) AS last_seen_at
  FROM user_observability_events
  WHERE account_id <> ''
    AND wallet_address <> ''
  GROUP BY account_id, wallet_address, COALESCE(NULLIF(wallet_scope, ''), 'unknown')
),
wallets AS (
  SELECT
    account_id,
    jsonb_agg(
      jsonb_build_object(
        'walletAddress', wallet_address,
        'role', role,
        'status', status,
        'source', source,
        'lastSeenAt', last_seen_at
      )
      ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, wallet_address
    ) AS wallets_json,
    count(*) FILTER (WHERE status = 'active')::integer AS active_wallet_count,
    count(*) FILTER (WHERE status <> 'active')::integer AS historical_wallet_count,
    max(last_seen_at) AS updated_at
  FROM wallet_rows
  GROUP BY account_id
),
provider_rows AS (
  SELECT
    account_id,
    'telegram' AS provider,
    '' AS provider_user_id_hash,
    'telegram_bot_events' AS source,
    max(created_at) AS last_seen_at
  FROM telegram_bot_events
  WHERE account_id <> ''
  GROUP BY account_id
  UNION
  SELECT
    account_id,
    provider,
    provider_user_id_hash,
    'user_observability_events' AS source,
    max(occurred_at) AS last_seen_at
  FROM user_observability_events
  WHERE account_id <> ''
    AND provider <> ''
  GROUP BY account_id, provider, provider_user_id_hash
),
providers AS (
  SELECT
    account_id,
    jsonb_agg(
      jsonb_build_object(
        'provider', provider,
        'providerUserIdHash', provider_user_id_hash,
        'source', source,
        'lastSeenAt', last_seen_at
      )
      ORDER BY provider, source
    ) AS providers_json,
    bool_or(provider = 'telegram') AS telegram_linked,
    max(last_seen_at) AS updated_at
  FROM provider_rows
  GROUP BY account_id
),
latest_observability AS (
  SELECT account_id, max(occurred_at) AS updated_at
  FROM user_observability_events
  WHERE account_id <> ''
  GROUP BY account_id
),
latest_tasks AS (
  SELECT account_id, max(updated_at) AS updated_at
  FROM non_fixture_task_projections
  WHERE account_id <> ''
  GROUP BY account_id
)
SELECT
  accounts.account_id,
  COALESCE(handles.public_handle, '') AS public_handle,
  ''::text AS display_name,
  COALESCE(providers.providers_json, '[]'::jsonb) AS providers_json,
  COALESCE(wallets.wallets_json, '[]'::jsonb) AS wallets_json,
  COALESCE(wallets.active_wallet_count, 0)::integer AS active_wallet_count,
  COALESCE(wallets.historical_wallet_count, 0)::integer AS historical_wallet_count,
  COALESCE(providers.telegram_linked, false) AS telegram_linked,
  GREATEST(
    COALESCE(handles.updated_at, 'epoch'::timestamptz),
    COALESCE(wallets.updated_at, 'epoch'::timestamptz),
    COALESCE(providers.updated_at, 'epoch'::timestamptz),
    COALESCE(latest_observability.updated_at, 'epoch'::timestamptz),
    COALESCE(latest_tasks.updated_at, 'epoch'::timestamptz)
  ) AS updated_at
FROM account_ids accounts
LEFT JOIN latest_handles handles ON handles.account_id = accounts.account_id
LEFT JOIN wallets ON wallets.account_id = accounts.account_id
LEFT JOIN providers ON providers.account_id = accounts.account_id
LEFT JOIN latest_observability ON latest_observability.account_id = accounts.account_id
LEFT JOIN latest_tasks ON latest_tasks.account_id = accounts.account_id;

DO $$
BEGIN
  IF to_regclass('public.orc_task_review_states') IS NOT NULL THEN
    EXECUTE $view$
      CREATE OR REPLACE VIEW orc_task_review_queue AS
      SELECT
        p.task_id,
        p.account_id,
        p.subject_wallet AS wallet_address,
        p.title,
        p.status AS task_status,
        p.reward_offer_pft::text AS reward_offer_pft,
        p.reward_actual_pft::text AS reward_actual_pft,
        p.request_bundle_cid,
        p.last_event_cid,
        p.last_event_tx_hash,
        p.updated_at AS task_updated_at,
        COALESCE(s.disposition, 'not_reviewed') AS review_disposition,
        COALESCE(s.action_required, false) AS action_required,
        s.action_owner,
        COALESCE(s.confidence, 'medium') AS confidence,
        COALESCE(s.categories, ARRAY[]::text[]) AS categories,
        COALESCE(s.integrity_signals, ARRAY[]::text[]) AS integrity_signals,
        COALESCE(s.summary, '') AS review_summary,
        COALESCE(s.recommended_action, '') AS recommended_action,
        s.reviewer_handle,
        s.reviewer_wallet,
        s.source_task_ids,
        s.source_cids,
        s.source_tx_hashes,
        s.reviewed_at,
        s.updated_at AS review_updated_at
      FROM task_projections p
      LEFT JOIN orc_task_review_states s
        ON s.task_id = p.task_id
      WHERE lower(COALESCE(NULLIF(p.task_kind, ''), p.metadata_json->'generatedTask'->>'task_kind', '')) = 'network'
        AND p.status = 'rewarded'
        AND p.reward_actual_pft > 0
        AND COALESCE(p.event_count, 0) > 0
        AND COALESCE(p.last_event_tx_hash, '') <> ''
        AND COALESCE(p.last_event_cid, '') <> ''
        AND COALESCE(p.source, '') <> 'directory_polish_local_fixture'
        AND COALESCE(p.metadata_json->>'directoryPolishFixture', 'false') <> 'true'
        AND p.task_id NOT LIKE 'directory_polish_%'
        AND p.task_id NOT LIKE 'task_cancel_paid_%';
    $view$;
  END IF;
END $$;
