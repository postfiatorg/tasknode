-- Migration 119 could not import accounts when the legacy runtime snapshot was
-- absent from the machine that performed the one-time migration. Some of those
-- accounts were recreated on their next provider login without their chosen
-- Hive handle, even though durable observability events still contain the
-- account-scoped public handle.
--
-- Recover only unambiguous evidence: one normalized, policy-valid historical
-- handle for an account, no current handle on that account, and no other
-- account owning the candidate handle.

WITH missing_accounts AS MATERIALIZED (
  SELECT account_id
  FROM app_accounts
  WHERE coalesce(hive_handle, '') = ''
    AND coalesce(account_json ->> 'hiveHandle', '') = ''
),
observed_handles AS (
  SELECT accounts.account_id, observed.hive_handle
  FROM missing_accounts accounts
  CROSS JOIN LATERAL (
    SELECT lower(btrim(recent_events.public_handle)) AS hive_handle
    FROM (
      SELECT events.public_handle
      FROM user_observability_events events
      WHERE events.account_id = accounts.account_id
      ORDER BY events.occurred_at DESC, events.id DESC
      -- Keep startup migration work bounded. The account migration happened
      -- recently, so the latest 250 events are sufficient recovery evidence
      -- without turning process startup into an unbounded event-table scan.
      LIMIT 250
    ) recent_events
    WHERE lower(btrim(recent_events.public_handle)) ~ '^[a-z0-9][a-z0-9_-]{2,29}$'
    GROUP BY lower(btrim(recent_events.public_handle))
  ) observed
),
unambiguous_handles AS (
  SELECT
    account_id,
    min(hive_handle) AS hive_handle
  FROM observed_handles
  GROUP BY account_id
  HAVING count(*) = 1
),
available_handles AS (
  SELECT candidates.account_id, candidates.hive_handle
  FROM unambiguous_handles candidates
  WHERE NOT EXISTS (
    SELECT 1
    FROM app_accounts owner
    WHERE owner.account_id <> candidates.account_id
      AND lower(coalesce(owner.hive_handle, '')) = candidates.hive_handle
  )
),
recovered_accounts AS (
  UPDATE app_accounts accounts
  SET hive_handle = candidates.hive_handle,
      account_json = jsonb_set(
        accounts.account_json,
        '{hiveHandle}',
        to_jsonb(candidates.hive_handle),
        true
      ),
      updated_at = now()
  FROM available_handles candidates
  WHERE accounts.account_id = candidates.account_id
    AND coalesce(accounts.hive_handle, '') = ''
    AND coalesce(accounts.account_json ->> 'hiveHandle', '') = ''
  RETURNING accounts.account_id, accounts.hive_handle
)
UPDATE auth_sessions sessions
SET session_json = sessions.session_json || jsonb_build_object(
  'hiveHandle', recovered.hive_handle
)
FROM recovered_accounts recovered
WHERE sessions.account_id = recovered.account_id
  AND sessions.revoked_at IS NULL
  AND sessions.expires_at > now();
