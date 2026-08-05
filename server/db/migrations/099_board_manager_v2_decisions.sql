-- Board Manager v2 (Gate C): reward budgets, agent decisions, spend ledger,
-- and audit log. Caps are enforced in code at decision time and re-validated
-- at reward publication. Budgets are mutable only by migration or the
-- operator admin token — never by the agent token.

CREATE TABLE IF NOT EXISTS board_reward_budgets (
  board_id text PRIMARY KEY REFERENCES network_projects(id) ON DELETE CASCADE,
  daily_budget_pft numeric(20, 6) NOT NULL DEFAULT 50000,
  per_task_cap_pft numeric(20, 6) NOT NULL DEFAULT 5000,
  per_user_7d_cap_pft numeric(20, 6) NOT NULL DEFAULT 60000,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO board_reward_budgets (board_id)
VALUES
  ('board_community_promotion'),
  ('board_pf_terminal'),
  ('board_postfiat_l1v2'),
  ('board_ai_l1_governance'),
  ('board_tasknode_fixes'),
  ('board_capital_markets')
ON CONFLICT (board_id) DO NOTHING;

-- Spend ledger: one row per published network-task reward decided by the
-- board manager. Written by the reward publisher, read by cap checks.
CREATE TABLE IF NOT EXISTS board_reward_spend (
  id text PRIMARY KEY,
  board_id text NOT NULL REFERENCES network_projects(id) ON DELETE CASCADE,
  task_id text NOT NULL,
  account_id text NOT NULL DEFAULT '',
  wallet_address text NOT NULL DEFAULT '',
  reward_pft numeric(20, 6) NOT NULL DEFAULT 0,
  decision_id text NOT NULL DEFAULT '',
  decided_by text NOT NULL DEFAULT 'board_manager_agent',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS board_reward_spend_task_idx
  ON board_reward_spend (task_id);

CREATE INDEX IF NOT EXISTS board_reward_spend_board_day_idx
  ON board_reward_spend (board_id, created_at DESC);

CREATE INDEX IF NOT EXISTS board_reward_spend_user_idx
  ON board_reward_spend (account_id, wallet_address, created_at DESC);

-- Agent decisions: the board manager writes intent here; the authority
-- worker consumes it. `reward_pft` is the code-clamped amount, never the
-- raw model ask.
CREATE TABLE IF NOT EXISTS bm_agent_decisions (
  id text PRIMARY KEY,
  kind text NOT NULL,
  board_id text NOT NULL DEFAULT '',
  task_id text NOT NULL,
  decision text NOT NULL DEFAULT '',
  requested_reward_pft numeric(20, 6) NOT NULL DEFAULT 0,
  reward_pft numeric(20, 6) NOT NULL DEFAULT 0,
  caps_applied_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason text NOT NULL DEFAULT '',
  user_feedback text NOT NULL DEFAULT '',
  verification_ask text NOT NULL DEFAULT '',
  verification_type text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  consumed_at timestamptz,
  consumed_ref_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL DEFAULT 'bm_cli',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bm_agent_decisions_kind_chk
    CHECK (kind IN ('review', 'verification_request')),
  CONSTRAINT bm_agent_decisions_status_chk
    CHECK (status IN ('pending', 'consumed', 'superseded', 'refused'))
);

CREATE INDEX IF NOT EXISTS bm_agent_decisions_task_kind_idx
  ON bm_agent_decisions (task_id, kind, status, created_at DESC);

CREATE INDEX IF NOT EXISTS bm_agent_decisions_board_idx
  ON bm_agent_decisions (board_id, kind, status, created_at DESC);

-- Append-only audit of every bm mutating command.
CREATE TABLE IF NOT EXISTS bm_audit_log (
  id text PRIMARY KEY,
  actor text NOT NULL DEFAULT 'board_manager_agent',
  board_id text NOT NULL DEFAULT '',
  command text NOT NULL DEFAULT '',
  args_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bm_audit_log_board_recent_idx
  ON bm_audit_log (board_id, created_at DESC);
