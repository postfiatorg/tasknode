CREATE TABLE IF NOT EXISTS network_projects (
  id text PRIMARY KEY,
  type text NOT NULL DEFAULT 'protocol_development',
  title text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  objective text NOT NULL DEFAULT '',
  about text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  priority integer NOT NULL DEFAULT 100,
  origin text NOT NULL DEFAULT 'system_seed',
  proposed_by text NOT NULL DEFAULT 'hive',
  proposed_at date,
  phase_label text NOT NULL DEFAULT '',
  phase_current integer NOT NULL DEFAULT 0,
  phase_total integer NOT NULL DEFAULT 0,
  pft_routed numeric(20, 6) NOT NULL DEFAULT 0,
  task_count integer NOT NULL DEFAULT 0,
  contributor_count integer NOT NULL DEFAULT 0,
  source_hive_secretary_report_id text NOT NULL DEFAULT '',
  source_hive_secretary_report_digest text NOT NULL DEFAULT '',
  source_inputs_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_projects_status_chk
    CHECK (status IN ('active', 'paused', 'completed', 'archived'))
);

CREATE INDEX IF NOT EXISTS network_projects_active_priority_idx
  ON network_projects (status, priority, title);

CREATE TABLE IF NOT EXISTS network_project_contributors (
  project_id text NOT NULL REFERENCES network_projects(id) ON DELETE CASCADE,
  wallet_address text NOT NULL,
  codename text NOT NULL DEFAULT '',
  archetype text NOT NULL DEFAULT '',
  badge_variant integer NOT NULL DEFAULT 0,
  allotted boolean NOT NULL DEFAULT false,
  cap integer NOT NULL DEFAULT 0,
  load integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  task_count integer NOT NULL DEFAULT 0,
  pft_earned numeric(20, 6) NOT NULL DEFAULT 0,
  last_active_label text NOT NULL DEFAULT '',
  role_label text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 100,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, wallet_address)
);

CREATE INDEX IF NOT EXISTS network_project_contributors_project_sort_idx
  ON network_project_contributors (project_id, sort_order, wallet_address);

CREATE TABLE IF NOT EXISTS network_project_task_refs (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES network_projects(id) ON DELETE CASCADE,
  task_id text NOT NULL DEFAULT '',
  request_id text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'proposed',
  assignee_wallet text NOT NULL DEFAULT '',
  reward_pft numeric(20, 6) NOT NULL DEFAULT 0,
  age_label text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 100,
  source text NOT NULL DEFAULT 'system_seed',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS network_project_task_refs_project_sort_idx
  ON network_project_task_refs (project_id, sort_order, id);

CREATE TABLE IF NOT EXISTS network_project_activity (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES network_projects(id) ON DELETE CASCADE,
  wallet_address text NOT NULL DEFAULT '',
  action text NOT NULL DEFAULT '',
  task_title text NOT NULL DEFAULT '',
  time_label text NOT NULL DEFAULT '',
  pft_amount numeric(20, 6),
  routing_label text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 100,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS network_project_activity_project_sort_idx
  ON network_project_activity (project_id, sort_order, id);

INSERT INTO network_projects (
  id,
  type,
  title,
  summary,
  objective,
  about,
  status,
  priority,
  origin,
  proposed_by,
  proposed_at,
  phase_label,
  phase_current,
  phase_total,
  pft_routed,
  task_count,
  contributor_count,
  source_inputs_json
)
VALUES (
  'pft_distribution_v3',
  'protocol_development',
  'PFT distribution v3',
  'Reward routing infrastructure rebuild. Adds parallel epoch settlement and verified reward distribution.',
  'Make reward routing reliable enough for network-scale task allocation.',
  'Rebuild of the reward routing infrastructure underlying every task payout. Adds parallel epoch settlement, multi-tenant task race resolution, and a verified attestation path for reward distribution edge cases. Currently in phase 3 of 5, focused on edge case audits and operator-facing flows.',
  'active',
  10,
  'system_seed',
  'hive',
  DATE '2026-02-14',
  '3 of 5',
  3,
  5,
  420,
  14,
  6,
  '{
    "inputs": ["hive_secretary_report", "pft_distribution_v3_project_spec"],
    "note": "Project exists before network task allocation; task refs, contributors, and activity attach only after live allocation.",
    "display_metrics": {
      "task_count": "planned_network_task_count",
      "contributor_count": "target_operator_count",
      "pft_routed": "planned_route_budget"
    }
  }'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  type = EXCLUDED.type,
  title = EXCLUDED.title,
  summary = EXCLUDED.summary,
  objective = EXCLUDED.objective,
  about = EXCLUDED.about,
  status = EXCLUDED.status,
  priority = EXCLUDED.priority,
  origin = EXCLUDED.origin,
  proposed_by = EXCLUDED.proposed_by,
  proposed_at = EXCLUDED.proposed_at,
  phase_label = EXCLUDED.phase_label,
  phase_current = EXCLUDED.phase_current,
  phase_total = EXCLUDED.phase_total,
  pft_routed = EXCLUDED.pft_routed,
  task_count = EXCLUDED.task_count,
  contributor_count = EXCLUDED.contributor_count,
  source_inputs_json = network_projects.source_inputs_json || EXCLUDED.source_inputs_json,
  updated_at = now();
