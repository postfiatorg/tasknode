CREATE TABLE IF NOT EXISTS account_identity_approvals (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider text NOT NULL DEFAULT '',
  provider_user_id_hash text NOT NULL DEFAULT '',
  public_handle text NOT NULL DEFAULT '',
  profile_url text NOT NULL DEFAULT '',
  approval_level text NOT NULL DEFAULT 'L0',
  approval_scope text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  approved_by_account_id text NOT NULL DEFAULT '',
  approved_by_operator text NOT NULL DEFAULT '',
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_identity_approvals_account_status_idx
  ON account_identity_approvals (account_id, status, provider, approval_scope);

CREATE TABLE IF NOT EXISTS network_badge_definitions (
  badge_id text PRIMARY KEY,
  label text NOT NULL,
  symbol_key text NOT NULL,
  public_description text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  default_public boolean NOT NULL DEFAULT true,
  max_payout_pft numeric NOT NULL DEFAULT 0,
  payout_policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  eligibility_policy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  allowed_work_types_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  required_provider_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_network_badges (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  badge_id text NOT NULL REFERENCES network_badge_definitions(badge_id),
  status text NOT NULL DEFAULT 'unverified',
  public_visible boolean NOT NULL DEFAULT true,
  selected_default boolean NOT NULL DEFAULT false,
  verified_by_account_id text NOT NULL DEFAULT '',
  verified_by_operator text NOT NULL DEFAULT '',
  evidence_task_id text NOT NULL DEFAULT '',
  evidence_url_or_ref text NOT NULL DEFAULT '',
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  validated_metrics_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, badge_id)
);

CREATE INDEX IF NOT EXISTS account_network_badges_account_status_idx
  ON account_network_badges (account_id, status, badge_id);

CREATE TABLE IF NOT EXISTS network_project_badge_requirements (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  work_type text NOT NULL,
  required_badge_id text NOT NULL REFERENCES network_badge_definitions(badge_id),
  capability_type text NOT NULL DEFAULT '',
  scope_label text NOT NULL DEFAULT '',
  scope_digest text NOT NULL DEFAULT '',
  max_payout_override_pft numeric,
  active boolean NOT NULL DEFAULT true,
  created_by_account_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS network_project_badge_requirements_project_work_idx
  ON network_project_badge_requirements (project_id, work_type, active);

INSERT INTO network_badge_definitions (
  badge_id,
  label,
  symbol_key,
  public_description,
  max_payout_pft,
  payout_policy_json,
  eligibility_policy_json,
  allowed_work_types_json,
  required_provider_json
)
VALUES
  ('kol', 'KOL', 'megaphone', 'Verified amplification identity for public narrative distribution.', 50000, '{"amplification_x":20000,"medium_article":50000}'::jsonb, '{"requires":"verified_audience_metric"}'::jsonb, '["amplification","amplification_x","public_announcement","article_distribution","medium_article"]'::jsonb, '["x"]'::jsonb),
  ('core_contributor', 'Core Contributor', 'git_pull_request', 'Sanctioned contributor for Post Fiat or Task Node code work.', 30000, '{"code_task":30000,"private_repo_code":30000,"core_repo_work":30000,"code_review":30000}'::jsonb, '{"requires":"linked_github_sanctioned_handle"}'::jsonb, '["code_task","private_repo_code","core_repo_work","code_review","capability_gating_task"]'::jsonb, '["github"]'::jsonb),
  ('expert', 'Expert', 'graduation_cap', 'Verified domain expertise from recent completed Personal Task work.', 30000, '{"expert_bundle":30000,"domain_analysis":30000,"expert_review":30000}'::jsonb, '{"requires":"20_personal_tasks_and_glm52_score_80"}'::jsonb, '["expert_bundle","domain_analysis","expert_review"]'::jsonb, '[]'::jsonb),
  ('project_leader', 'Project Leader', 'crown', 'Discretionary authority to define special or open-source projects.', 30000, '{"special_project_definition":30000,"open_source_project_definition":30000}'::jsonb, '{"requires":"backend_hive_handle_allowlist"}'::jsonb, '["project_management","special_project_definition","open_source_project_definition"]'::jsonb, '[]'::jsonb),
  ('qa_worker', 'QA Worker', 'bug', 'Verified app user eligible for capped product QA and repro packets.', 5000, '{"qa_report":5000,"product_qa":5000,"repro_packet":5000}'::jsonb, '{"requires":"telegram_discord_usdc_top_up"}'::jsonb, '["qa_report","product_qa","repro_packet"]'::jsonb, '["telegram","discord"]'::jsonb)
ON CONFLICT (badge_id) DO UPDATE SET
  label = EXCLUDED.label,
  symbol_key = EXCLUDED.symbol_key,
  public_description = EXCLUDED.public_description,
  max_payout_pft = EXCLUDED.max_payout_pft,
  payout_policy_json = EXCLUDED.payout_policy_json,
  eligibility_policy_json = EXCLUDED.eligibility_policy_json,
  allowed_work_types_json = EXCLUDED.allowed_work_types_json,
  required_provider_json = EXCLUDED.required_provider_json,
  active = true,
  updated_at = now();
