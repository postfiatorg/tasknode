-- Value accountability (2026-09-26).
--
-- Accounts that were paid for work the network task content policy now bans
-- (critiques of published writing, audit/review write-ups) receive one
-- mandatory accountability task. They must show concrete market-cap accretion
-- and a Discord sign-off from a different member. The board manager judges the
-- submission; a rejection, refusal or missed deadline blacklists the account.
-- Blacklisted accounts receive no new network tasks and no reward payments.

CREATE TABLE IF NOT EXISTS value_accountability_cases (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  wallet_address text NOT NULL DEFAULT '',
  public_handle text NOT NULL DEFAULT '',
  cohort_policy text NOT NULL,
  flagged_task_ids text[] NOT NULL DEFAULT '{}',
  flagged_task_count integer NOT NULL DEFAULT 0,
  flagged_pft numeric(20, 6) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending_issue'
    CHECK (status IN ('pending_issue', 'issued', 'cleared', 'blacklisted', 'exempt')),
  board_manager_run_id text NOT NULL DEFAULT '',
  accountability_task_id text NOT NULL DEFAULT '',
  deadline_at timestamptz,
  verdict_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS value_accountability_cases_account_policy_idx
  ON value_accountability_cases (account_id, cohort_policy);
CREATE INDEX IF NOT EXISTS value_accountability_cases_status_idx
  ON value_accountability_cases (status, deadline_at);
CREATE INDEX IF NOT EXISTS value_accountability_cases_task_idx
  ON value_accountability_cases (accountability_task_id);

CREATE TABLE IF NOT EXISTS account_blacklist (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  wallet_addresses text[] NOT NULL DEFAULT '{}',
  public_handle text NOT NULL DEFAULT '',
  reason_code text NOT NULL,
  reason text NOT NULL DEFAULT '',
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'operator',
  case_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'lifted')),
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at timestamptz,
  lifted_by text NOT NULL DEFAULT '',
  lift_reason text NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS account_blacklist_active_account_idx
  ON account_blacklist (account_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS account_blacklist_wallets_idx
  ON account_blacklist USING gin (wallet_addresses);

-- The Value Accountability board: one mandatory task per flagged account.
-- Pays at most 1 PFT; its purpose is the verdict, not a reward.
INSERT INTO network_projects (
  id, type, title, summary, objective, about,
  status, priority, origin, proposed_by, proposed_at,
  phase_label, phase_current, phase_total,
  source_inputs_json, metadata_json
)
VALUES (
  'board_value_accountability',
  'network_validation',
  'Value Accountability',
  'Mandatory justification for PFT paid on commentary and audit write-ups.',
  'Recover network value: accounts paid for banned task shapes must show market-cap accretion or be blacklisted.',
  'Accounts that earned PFT for critiques of published writing or audit/review write-ups receive one mandatory task. They must show concrete, verifiable evidence that their paid work increased Post Fiat market cap, plus a Discord sign-off from a different member. The board manager judges strictly; rejection, refusal or a missed deadline blacklists the account.',
  'active', 90, 'operator_seed', 'goodalexander', DATE '2026-09-26',
  'Operating', 0, 0,
  '{"inputs": ["operator_mandate_20260926_value_accountability"]}'::jsonb,
  '{
    "deterministic": true,
    "board_manager_v2": true,
    "board_seed_source": "migration_148_value_accountability",
    "evidence_norms": ["discord_message_link", "onchain_tx", "public_metric"],
    "routing_constraints": {}
  }'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  summary = EXCLUDED.summary,
  objective = EXCLUDED.objective,
  about = EXCLUDED.about,
  status = EXCLUDED.status,
  metadata_json = network_projects.metadata_json || EXCLUDED.metadata_json,
  updated_at = now();

INSERT INTO board_reward_budgets (board_id, daily_budget_pft, per_task_cap_pft, per_user_7d_cap_pft)
VALUES ('board_value_accountability', 100, 1, 1)
ON CONFLICT (board_id) DO NOTHING;
