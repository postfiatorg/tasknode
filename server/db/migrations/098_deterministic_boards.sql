-- Deterministic boards (Board Manager resurrection, Gate A).
--
-- The network runs exactly six operator-defined boards. Model-driven board
-- creation is retired; boards change only by migration or the board admin
-- route. See work_in_progress/board_manager_resurrection_plan_20260805.md.

-- 1. Archive every project that is not one of the six boards, with the
--    operator archive lock so no model path can restore or mutate it.
UPDATE network_projects
SET status = 'archived',
    metadata_json = COALESCE(metadata_json, '{}'::jsonb) || jsonb_build_object(
      'operator_archived', true,
      'archive_lock_applied_at', now(),
      'archive_lock_source', 'migration_098_deterministic_boards'
    ),
    updated_at = now()
WHERE id NOT IN (
    'board_community_promotion',
    'board_pf_terminal',
    'board_postfiat_l1v2',
    'board_ai_l1_governance',
    'board_tasknode_fixes',
    'board_capital_markets'
  )
  AND status <> 'archived';

-- 2. Seed / refresh the six boards. Idempotent upsert with stable ids.
INSERT INTO network_projects (
  id, type, title, summary, objective, about,
  status, priority, origin, proposed_by, proposed_at,
  phase_label, phase_current, phase_total,
  source_inputs_json, metadata_json
)
VALUES
  (
    'board_community_promotion',
    'protocol_marketing',
    'Community & Promotion',
    'Run and amplify official Post Fiat X content and the public website.',
    'Grow credible public reach for Post Fiat through amplification of official X posts and improvements to postfiatorg.github.io.',
    'This board routes amplification and promotion work tied to the official Post Fiat X account and the public website. Evidence is X links and screenshots; the board manager reads the official account state for context before generating tasks.',
    'active', 10, 'operator_seed', 'goodalexander', DATE '2026-08-05',
    'Operating', 0, 0,
    '{"inputs": ["operator_mandate_20260805"]}'::jsonb,
    '{
      "deterministic": true,
      "board_manager_v2": true,
      "board_seed_source": "migration_098_deterministic_boards",
      "sources": {
        "x_accounts": ["PostFiatOrg"],
        "websites": ["https://postfiatorg.github.io"],
        "repos": ["postfiatorg.github.io"]
      },
      "evidence_norms": ["x_link", "screenshot"],
      "routing_constraints": {}
    }'::jsonb
  ),
  (
    'board_pf_terminal',
    'protocol_applications',
    'PF Terminal',
    'Post Fiat''s internal terminal tool.',
    'Improve PF Terminal through repo-grounded contributions reviewed against the actual codebase.',
    'This board routes work on the PF Terminal internal tool. Tasks are generated from real repository state and submissions are reviewed as code first: PRs, diffs, and reproducible artifacts.',
    'active', 20, 'operator_seed', 'goodalexander', DATE '2026-08-05',
    'Operating', 0, 0,
    '{"inputs": ["operator_mandate_20260805"]}'::jsonb,
    '{
      "deterministic": true,
      "board_manager_v2": true,
      "board_seed_source": "migration_098_deterministic_boards",
      "sources": { "repos": ["PfTerminal"] },
      "evidence_norms": ["github_pr", "screenshot"],
      "routing_constraints": {}
    }'::jsonb
  ),
  (
    'board_postfiat_l1v2',
    'protocol_development',
    'PostfiatL1V2',
    'Version 2 of the Post Fiat Layer 1.',
    'Advance PostfiatL1V2 through repo-grounded protocol contributions.',
    'This board routes protocol development work on the second version of the Post Fiat L1. Tasks cite real files and issues in the postfiatl1v2 repository; review is code review.',
    'active', 30, 'operator_seed', 'goodalexander', DATE '2026-08-05',
    'Operating', 0, 0,
    '{"inputs": ["operator_mandate_20260805"]}'::jsonb,
    '{
      "deterministic": true,
      "board_manager_v2": true,
      "board_seed_source": "migration_098_deterministic_boards",
      "sources": { "repos": ["postfiatl1v2"] },
      "evidence_norms": ["github_pr"],
      "routing_constraints": {}
    }'::jsonb
  ),
  (
    'board_ai_l1_governance',
    'network_validation',
    'AI Layer 1 Governance',
    'The XRPL fork with governance replay.',
    'Advance the governance-replay XRPL fork through repo-grounded contributions.',
    'This board routes work on the AI Layer 1 governance stack: the XRPL fork with governance replay and the supporting UNL scoring work. Tasks are generated against the postfiatd, rippled, and dynamic-unl-scoring repositories.',
    'active', 40, 'operator_seed', 'goodalexander', DATE '2026-08-05',
    'Operating', 0, 0,
    '{"inputs": ["operator_mandate_20260805"]}'::jsonb,
    '{
      "deterministic": true,
      "board_manager_v2": true,
      "board_seed_source": "migration_098_deterministic_boards",
      "sources": { "repos": ["postfiatd", "rippled", "dynamic-unl-scoring"] },
      "evidence_norms": ["github_pr"],
      "routing_constraints": {}
    }'::jsonb
  ),
  (
    'board_tasknode_fixes',
    'protocol_applications',
    'Task Node Fixes',
    'Fixes to the Task Node app itself.',
    'Repair and harden Task Node. Work is assignable only to goodalexander, who holds code access.',
    'This board tracks defects and hardening work on Task Node. Because only goodalexander has code access to the Task Node deployment, tasks on this board are assignable only to goodalexander.',
    'active', 50, 'operator_seed', 'goodalexander', DATE '2026-08-05',
    'Operating', 0, 0,
    '{"inputs": ["operator_mandate_20260805"]}'::jsonb,
    '{
      "deterministic": true,
      "board_manager_v2": true,
      "board_seed_source": "migration_098_deterministic_boards",
      "sources": { "repos": ["tasknodeofficial"] },
      "evidence_norms": ["github_pr"],
      "routing_constraints": { "assignable_handles": ["goodalexander"] }
    }'::jsonb
  ),
  (
    'board_capital_markets',
    'alpha_generation',
    'Capital Markets',
    'AGTI, goodalexander, and community-sourced alpha ideas.',
    'Engage with AGTI and community capital-markets research; route credible alpha ideas into reviewable artifacts.',
    'This board routes capital markets engagement: AGTI research, goodalexander''s public work, and community-sourced alpha ideas. Context repos are goodalexander.github.io and agti, plus agti.net.',
    'active', 60, 'operator_seed', 'goodalexander', DATE '2026-08-05',
    'Operating', 0, 0,
    '{"inputs": ["operator_mandate_20260805"]}'::jsonb,
    '{
      "deterministic": true,
      "board_manager_v2": true,
      "board_seed_source": "migration_098_deterministic_boards",
      "sources": {
        "repos": ["goodalexander.github.io", "agti"],
        "websites": ["https://agti.net"]
      },
      "evidence_norms": ["github_pr", "x_link", "screenshot"],
      "routing_constraints": {}
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
  source_inputs_json = network_projects.source_inputs_json || EXCLUDED.source_inputs_json,
  metadata_json = network_projects.metadata_json || EXCLUDED.metadata_json,
  updated_at = now();
