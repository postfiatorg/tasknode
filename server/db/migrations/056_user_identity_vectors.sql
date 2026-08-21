CREATE OR REPLACE VIEW user_identity_vectors AS
WITH account_ids AS (
  SELECT DISTINCT account_id
  FROM pftl_sync_wallets
  WHERE COALESCE(account_id, '') <> ''
  UNION
  SELECT DISTINCT account_id
  FROM task_projections
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
  FROM task_projections
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
  FROM task_projections
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
