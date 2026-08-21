-- Migration 119 made app_accounts the durable account authority. Older
-- production identities already had durable public/profile and wallet rows,
-- but some no longer existed in the legacy JSON snapshot used by the one-time
-- account importer. Recover those account shells from the durable profile
-- census without inventing provider credentials or email ownership.

DO $migration$
BEGIN
  -- Migration 053 leaves this table absent when pgvector is unavailable.
  -- Fresh self-hosted installs without that optional extension have nothing
  -- to recover and must still be able to complete the base schema.
  IF to_regclass('public.recommended_connection_profiles') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE $recovery$
WITH recoverable_profiles AS (
  SELECT
    profile.account_id,
    profile.display_name,
    profile.hive_handle,
    profile.visibility,
    profile.discoverable,
    profile.disabled_at,
    profile.created_at,
    profile.updated_at,
    CASE
      WHEN COALESCE(profile.hive_handle, '') <> ''
       AND NOT EXISTS (
         SELECT 1
         FROM app_accounts existing
         WHERE lower(existing.hive_handle) = lower(profile.hive_handle)
           AND existing.account_id <> profile.account_id
       )
      THEN profile.hive_handle
      ELSE ''
    END AS recovered_handle
  FROM recommended_connection_profiles profile
  WHERE COALESCE(profile.account_id, '') <> ''
    AND COALESCE(profile.packet_json->>'directoryPolishFixture', 'false') <> 'true'
    AND COALESCE(profile.packet_digest, '') NOT LIKE 'directory_polish_%'
    AND COALESCE(profile.network_profile_id, '') NOT LIKE 'directory_polish_%'
    AND COALESCE(profile.network_profile_digest, '') NOT LIKE 'directory_polish_%'
    AND COALESCE(profile.embedding_model, '') <> 'directory-polish-local'
)
INSERT INTO app_accounts (
  account_id,
  account_json,
  hive_handle,
  status,
  created_at,
  updated_at
)
SELECT
  profile.account_id,
  jsonb_build_object(
    'id', profile.account_id,
    'status', 'active',
    'displayName', COALESCE(
      NULLIF(profile.display_name, ''),
      CASE WHEN profile.recovered_handle <> '' THEN '@' || profile.recovered_handle END,
      'Task Node member'
    ),
    'publicDisplayName', COALESCE(NULLIF(profile.display_name, ''), ''),
    'hiveHandle', profile.recovered_handle,
    'profileVisibility', CASE
      WHEN profile.visibility = 'public'
       AND profile.discoverable = true
       AND profile.disabled_at IS NULL
      THEN 'public'
      ELSE 'private'
    END,
    'linkedProviders', '[]'::jsonb,
    'assurance', 'low',
    'recoverySource', 'durable_profile_census',
    'createdAt', profile.created_at,
    'updatedAt', profile.updated_at
  ),
  NULLIF(profile.recovered_handle, ''),
  'active',
  profile.created_at,
  profile.updated_at
FROM recoverable_profiles profile
ON CONFLICT (account_id) DO NOTHING
  $recovery$;
END
$migration$;
