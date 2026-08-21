CREATE TABLE IF NOT EXISTS user_observability_events (
  id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL,
  event_version integer NOT NULL DEFAULT 1,
  account_id text NOT NULL DEFAULT '',
  public_handle text NOT NULL DEFAULT '',
  wallet_address text NOT NULL DEFAULT '',
  wallet_scope text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT '',
  provider_user_id_hash text NOT NULL DEFAULT '',
  session_id_hash text NOT NULL DEFAULT '',
  request_id text NOT NULL DEFAULT '',
  task_id text NOT NULL DEFAULT '',
  conversation_id text NOT NULL DEFAULT '',
  project_id text NOT NULL DEFAULT '',
  allocation_id text NOT NULL DEFAULT '',
  generation_job_id text NOT NULL DEFAULT '',
  model_run_id text NOT NULL DEFAULT '',
  tx_hash text NOT NULL DEFAULT '',
  cid text NOT NULL DEFAULT '',
  source_surface text NOT NULL DEFAULT '',
  source_route text NOT NULL DEFAULT '',
  result_status text NOT NULL DEFAULT '',
  reason_code text NOT NULL DEFAULT '',
  identity_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  privacy_class text NOT NULL DEFAULT 'internal',
  retention_until timestamptz,
  CONSTRAINT user_observability_events_privacy_class_chk
    CHECK (privacy_class IN ('public', 'internal', 'sensitive_reference', 'security'))
);

CREATE INDEX IF NOT EXISTS user_observability_events_account_recent_idx
  ON user_observability_events (account_id, occurred_at DESC, id);

CREATE INDEX IF NOT EXISTS user_observability_events_wallet_recent_idx
  ON user_observability_events (wallet_address, occurred_at DESC, id)
  WHERE wallet_address <> '';

CREATE INDEX IF NOT EXISTS user_observability_events_type_recent_idx
  ON user_observability_events (event_type, occurred_at DESC, id);

CREATE INDEX IF NOT EXISTS user_observability_events_task_recent_idx
  ON user_observability_events (task_id, occurred_at DESC, id)
  WHERE task_id <> '';

CREATE INDEX IF NOT EXISTS user_observability_events_request_recent_idx
  ON user_observability_events (request_id, occurred_at DESC, id)
  WHERE request_id <> '';

CREATE OR REPLACE VIEW user_daily_usage_rollups AS
SELECT
  account_id,
  occurred_at::date AS day,
  count(*) FILTER (WHERE event_type = 'user.session.started')::integer AS session_count,
  count(DISTINCT source_surface) FILTER (WHERE source_surface <> '')::integer AS active_surface_count,
  count(*) FILTER (WHERE event_type = 'user.chat.message_sent')::integer AS chat_message_count,
  count(*) FILTER (WHERE event_type IN ('user.chat.model_run_completed', 'user.chat.model_run_failed'))::integer AS model_run_count,
  count(*) FILTER (WHERE event_type LIKE 'user.task.%')::integer AS task_action_count,
  count(*) FILTER (WHERE event_type LIKE 'user.hive.%')::integer AS hive_action_count,
  count(*) FILTER (WHERE event_type LIKE 'user.telegram.%')::integer AS telegram_event_count,
  count(*) FILTER (WHERE event_type LIKE 'user.billing.%')::integer AS top_up_event_count,
  min(occurred_at) AS first_seen_at,
  max(occurred_at) AS last_seen_at
FROM user_observability_events
WHERE account_id <> ''
GROUP BY account_id, occurred_at::date;

CREATE OR REPLACE VIEW user_task_behavior_rollups AS
SELECT
  account_id,
  subject_wallet AS wallet_address,
  COALESCE(NULLIF(task_kind, ''), 'unknown') AS task_kind,
  min(created_at) AS window_start,
  max(updated_at) AS window_end,
  count(*) FILTER (WHERE status IN ('proposed', 'accepted', 'submitted', 'verification_requested', 'verification_response_submitted', 'rewarded', 'refused', 'cancelled', 'rejected', 'expired'))::integer AS offered_count,
  count(*) FILTER (WHERE status IN ('accepted', 'submitted', 'verification_requested', 'verification_response_submitted', 'rewarded'))::integer AS accepted_count,
  count(*) FILTER (WHERE status = 'refused')::integer AS refused_count,
  count(*) FILTER (WHERE status = 'expired')::integer AS expired_count,
  count(*) FILTER (WHERE status IN ('submitted', 'verification_requested', 'verification_response_submitted', 'rewarded'))::integer AS submitted_count,
  count(*) FILTER (WHERE status = 'rewarded')::integer AS rewarded_count,
  COALESCE(sum(reward_actual_pft) FILTER (WHERE reward_actual_pft > 0), 0)::numeric(18, 6) AS reward_pft,
  CASE
    WHEN count(*) FILTER (WHERE status IN ('proposed', 'accepted', 'submitted', 'verification_requested', 'verification_response_submitted', 'rewarded', 'refused', 'cancelled', 'rejected', 'expired')) = 0
      THEN 0::numeric
    ELSE (
      count(*) FILTER (WHERE status = 'refused')::numeric /
      count(*) FILTER (WHERE status IN ('proposed', 'accepted', 'submitted', 'verification_requested', 'verification_response_submitted', 'rewarded', 'refused', 'cancelled', 'rejected', 'expired'))::numeric
    )
  END AS refusal_rate
FROM task_projections
WHERE account_id <> '' OR subject_wallet <> ''
GROUP BY account_id, subject_wallet, COALESCE(NULLIF(task_kind, ''), 'unknown');

CREATE OR REPLACE VIEW user_reward_rollups AS
WITH task_rewards AS (
  SELECT
    account_id,
    subject_wallet AS wallet_address,
    updated_at::date AS day,
    COALESCE(sum(reward_actual_pft) FILTER (WHERE reward_actual_pft > 0), 0)::numeric(18, 6) AS task_reward_pft,
    0::numeric(18, 6) AS daily_airdrop_pft,
    0::numeric(18, 6) AS initiation_grant_pft,
    0::numeric(18, 6) AS top_up_credit_usd
  FROM task_projections
  WHERE reward_actual_pft > 0
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
