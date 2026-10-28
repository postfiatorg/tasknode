-- Provider costs can be smaller than a USD microdollar. Preserve the reported
-- amount exactly; every existing value is unchanged by this widening.
-- The reward rollup depends on amount_usd. Recreate its identical definition
-- and grants atomically (no CASCADE); unexpected dependencies abort release.
SET LOCAL lock_timeout = '5s';
DO $$
DECLARE
  definition text;
  owner_name text;
  permissions jsonb;
  permission jsonb;
BEGIN
  SELECT pg_get_viewdef('user_reward_rollups'::regclass, true), pg_get_userbyid(relowner)
    INTO definition, owner_name FROM pg_class WHERE oid='user_reward_rollups'::regclass;
  SELECT coalesce(jsonb_agg(jsonb_build_object('grantee',grantee,'privilege',privilege_type,'grantable',is_grantable)), '[]'::jsonb)
    INTO permissions FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='user_reward_rollups';
  DROP VIEW user_reward_rollups;
  ALTER TABLE billing_ledger_entries
    ALTER COLUMN amount_usd TYPE numeric(30,12),
    ALTER COLUMN provider_cost_usd TYPE numeric(30,12);
  EXECUTE 'CREATE VIEW user_reward_rollups AS ' || definition;
  EXECUTE format('ALTER VIEW user_reward_rollups OWNER TO %I', owner_name);
  FOR permission IN SELECT * FROM jsonb_array_elements(permissions) LOOP
    EXECUTE format('GRANT %s ON user_reward_rollups TO %s%s', permission->>'privilege',
      CASE WHEN permission->>'grantee'='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(permission->>'grantee') END,
      CASE WHEN permission->>'grantable'='YES' THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;
ALTER TABLE billing_accounts
  ALTER COLUMN current_spend_usd TYPE numeric(30,12),
  ALTER COLUMN current_credit_usd TYPE numeric(30,12);
ALTER TABLE research_gateway_jobs ALTER COLUMN cost_usd TYPE numeric(30,12);
