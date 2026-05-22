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
VALUES
  (
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
    '{"inputs":["hive_secretary_report","operator_seed_project_spec"],"note":"Project exists before network task allocation; task refs attach later."}'::jsonb
  ),
  (
    'cross_chain_liquidity_index',
    'protocol_development',
    'Cross-chain liquidity index',
    'Aggregating depth across 7 venues. Phase 2 of 4.',
    'Build a reliable cross-chain liquidity readout for future alpha and routing work.',
    '',
    'active',
    20,
    'system_seed',
    'hive',
    NULL,
    '2 of 4',
    2,
    4,
    310,
    9,
    5,
    '{"inputs":["hive_secretary_report","operator_seed_project_spec"]}'::jsonb
  ),
  (
    'operator_onboarding_redesign',
    'protocol_applications',
    'Operator onboarding redesign',
    'Reworking the first 24 hours after a node joins.',
    'Improve the first-session path from account creation to useful network work.',
    '',
    'active',
    30,
    'system_seed',
    'hive',
    NULL,
    '',
    0,
    0,
    45,
    3,
    2,
    '{"inputs":["hive_secretary_report","operator_seed_project_spec"]}'::jsonb
  ),
  (
    'conference_circuit_q3',
    'protocol_marketing',
    'Conference circuit Q3',
    'EthCC, Solana Breakpoint, Token2049 presence.',
    'Coordinate high-leverage protocol presence and narrative distribution around major conferences.',
    '',
    'active',
    40,
    'system_seed',
    'hive',
    NULL,
    '',
    0,
    0,
    180,
    6,
    3,
    '{"inputs":["hive_secretary_report","operator_seed_project_spec"]}'::jsonb
  ),
  (
    'whitepaper_v2_research',
    'protocol_marketing',
    'Whitepaper v2 research',
    'Empirical addendum and game theory section.',
    'Produce a clearer written protocol argument backed by empirical and mechanism-design work.',
    '',
    'active',
    50,
    'system_seed',
    'hive',
    NULL,
    '',
    0,
    0,
    260,
    7,
    4,
    '{"inputs":["hive_secretary_report","operator_seed_project_spec"]}'::jsonb
  ),
  (
    'alpha_digest_weekly',
    'alpha_generation',
    'Alpha digest weekly',
    'Recurring. Market structure observations.',
    'Maintain a recurring market-structure intelligence packet for the network.',
    '',
    'active',
    60,
    'system_seed',
    'hive',
    NULL,
    '',
    0,
    0,
    90,
    4,
    2,
    '{"inputs":["hive_secretary_report","operator_seed_project_spec"]}'::jsonb
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

INSERT INTO network_project_contributors (
  project_id,
  wallet_address,
  codename,
  archetype,
  badge_variant,
  allotted,
  cap,
  load,
  status,
  task_count,
  pft_earned,
  last_active_label,
  role_label,
  sort_order
)
VALUES
  ('pft_distribution_v3', '0x71f...4ab2', 'Sentinel', 'Builder · verification', 0, true, 12, 11, 'active', 4, 86, '6m ago', 'lead', 10),
  ('pft_distribution_v3', '0xb35...027e', 'Helix', 'Builder · liquidity', 3, true, 10, 9, 'active', 3, 64, '22m ago', '', 20),
  ('pft_distribution_v3', '0xa12...77df', 'Anchor', 'Builder · protocol', 6, false, 6, 5, 'active', 3, 72, '3h ago', '', 30),
  ('pft_distribution_v3', '0xc9e...d801', 'Cipher', 'Researcher · market structure', 1, true, 10, 7, 'active', 2, 48, '1h ago', '', 40),
  ('pft_distribution_v3', '0x10c...8a44', 'Glyph', 'Writer · whitepaper', 5, true, 8, 6, 'active', 1, 22, '1h ago', '', 50),
  ('pft_distribution_v3', '0x9f3...18ee', 'Drift', 'Researcher · alpha', 7, false, 5, 2, 'quiet', 1, 28, '8h ago', '', 60),
  ('cross_chain_liquidity_index', '0xb35...027e', 'Helix', 'Builder · liquidity', 3, true, 10, 9, 'active', 0, 0, '', '', 10),
  ('cross_chain_liquidity_index', '0xc9e...d801', 'Cipher', 'Researcher · market structure', 1, true, 10, 7, 'active', 0, 0, '', '', 20),
  ('operator_onboarding_redesign', '0x42a...91fc', 'Beacon', 'Designer · onboarding', 2, false, 6, 3, 'active', 0, 0, '', '', 10),
  ('conference_circuit_q3', '0xf80...22bb', 'Quartz', 'Community · ops', 4, true, 8, 4, 'quiet', 0, 0, '', '', 10),
  ('whitepaper_v2_research', '0x10c...8a44', 'Glyph', 'Writer · whitepaper', 5, true, 8, 6, 'active', 0, 0, '', '', 10),
  ('alpha_digest_weekly', '0x9f3...18ee', 'Drift', 'Researcher · alpha', 7, false, 5, 2, 'quiet', 0, 0, '', '', 10)
ON CONFLICT (project_id, wallet_address) DO UPDATE SET
  codename = EXCLUDED.codename,
  archetype = EXCLUDED.archetype,
  badge_variant = EXCLUDED.badge_variant,
  allotted = EXCLUDED.allotted,
  cap = EXCLUDED.cap,
  load = EXCLUDED.load,
  status = EXCLUDED.status,
  task_count = EXCLUDED.task_count,
  pft_earned = EXCLUDED.pft_earned,
  last_active_label = EXCLUDED.last_active_label,
  role_label = EXCLUDED.role_label,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

INSERT INTO network_project_task_refs (
  id,
  project_id,
  title,
  state,
  assignee_wallet,
  reward_pft,
  age_label,
  sort_order
)
VALUES
  ('np_task_pft_v3_001', 'pft_distribution_v3', 'Audit reward distribution edge case in epoch transitions', 'proposed', '0x71f...4ab2', 4.5, 'awaiting accept', 10),
  ('np_task_pft_v3_002', 'pft_distribution_v3', 'Parallel settlement implementation', 'accepted', '0xb35...027e', 5.2, 'day 3', 20),
  ('np_task_pft_v3_003', 'pft_distribution_v3', 'Multi-tenant task UI flows', 'submitted', '0xc9e...d801', 3.5, 'day 1', 30),
  ('np_task_pft_v3_004', 'pft_distribution_v3', 'Verified reward attestation', 'verification_requested', '0xa12...77df', 6.0, 'response needed', 40),
  ('np_task_pft_v3_005', 'pft_distribution_v3', 'Operator notification protocol', 'verification_response', '0x10c...8a44', 2.5, 'awaiting decision', 50),
  ('np_task_pft_v3_006', 'pft_distribution_v3', 'Epoch-3 incident retrospective writeup', 'paid', '0x71f...4ab2', 3.0, '2d ago', 60),
  ('np_task_pft_v3_007', 'pft_distribution_v3', 'Race condition reproduction harness', 'paid', '0xa12...77df', 4.0, '4d ago', 70),
  ('np_task_pft_v3_008', 'pft_distribution_v3', 'Settlement latency benchmarks', 'paid', '0xb35...027e', 2.8, '5d ago', 80)
ON CONFLICT (id) DO UPDATE SET
  project_id = EXCLUDED.project_id,
  title = EXCLUDED.title,
  state = EXCLUDED.state,
  assignee_wallet = EXCLUDED.assignee_wallet,
  reward_pft = EXCLUDED.reward_pft,
  age_label = EXCLUDED.age_label,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

INSERT INTO network_project_activity (
  id,
  project_id,
  wallet_address,
  action,
  task_title,
  time_label,
  pft_amount,
  sort_order
)
VALUES
  ('np_activity_pft_v3_001', 'pft_distribution_v3', '0x71f...4ab2', 'accepted', 'Audit reward distribution edge case', '2m ago', NULL, 10),
  ('np_activity_pft_v3_002', 'pft_distribution_v3', '0xb35...027e', 'submitted', 'Parallel settlement implementation', '14m ago', NULL, 20),
  ('np_activity_pft_v3_003', 'pft_distribution_v3', '0xc9e...d801', 'paid', 'Multi-tenant task UI flows · v1', '1h ago', 1.5, 30),
  ('np_activity_pft_v3_004', 'pft_distribution_v3', '0xa12...77df', 'v_response', 'Race condition reproduction harness', '3h ago', NULL, 40)
ON CONFLICT (id) DO UPDATE SET
  project_id = EXCLUDED.project_id,
  wallet_address = EXCLUDED.wallet_address,
  action = EXCLUDED.action,
  task_title = EXCLUDED.task_title,
  time_label = EXCLUDED.time_label,
  pft_amount = EXCLUDED.pft_amount,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();
