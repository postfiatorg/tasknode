-- Public/fresh-install defaults for the six application board identifiers.
--
-- The private production seed is intentionally excluded from public source.
-- These neutral defaults keep the public schema and UI usable without copying
-- operator identities, private repository access rules, or production source
-- configuration. ON CONFLICT preserves every existing operator-managed board.

INSERT INTO network_projects (
  id, type, title, summary, objective, about,
  status, priority, origin, proposed_by, phase_label,
  source_inputs_json, metadata_json
)
VALUES
  (
    'board_community_promotion', 'protocol_marketing', 'Community & Promotion',
    'Coordinate public community and promotion work.',
    'Turn public communications goals into reviewable community tasks.',
    'Configure approved public channels and evidence requirements for this board in the operator environment.',
    'active', 10, 'public_default', 'system', 'Operating',
    '{"inputs": []}'::jsonb,
    '{"public_default": true, "evidence_norms": ["public_link", "screenshot"], "routing_constraints": {}}'::jsonb
  ),
  (
    'board_pf_terminal', 'protocol_applications', 'PF Terminal',
    'Coordinate contributions to a professional terminal application.',
    'Turn terminal product needs into repository-grounded tasks.',
    'Configure the authorized terminal repositories and review rules in the operator environment.',
    'active', 20, 'public_default', 'system', 'Operating',
    '{"inputs": []}'::jsonb,
    '{"public_default": true, "evidence_norms": ["github_pr", "screenshot"], "routing_constraints": {}}'::jsonb
  ),
  (
    'board_postfiat_l1v2', 'protocol_development', 'PostfiatL1V2',
    'Coordinate protocol development contributions.',
    'Turn protocol needs into repository-grounded engineering tasks.',
    'Configure the authorized protocol repositories and review rules in the operator environment.',
    'active', 30, 'public_default', 'system', 'Operating',
    '{"inputs": []}'::jsonb,
    '{"public_default": true, "evidence_norms": ["github_pr"], "routing_constraints": {}}'::jsonb
  ),
  (
    'board_ai_l1_governance', 'network_validation', 'AI Layer 1 Governance',
    'Coordinate governance and network-validation contributions.',
    'Turn governance and validation needs into reviewable engineering tasks.',
    'Configure the authorized governance repositories and review rules in the operator environment.',
    'active', 40, 'public_default', 'system', 'Operating',
    '{"inputs": []}'::jsonb,
    '{"public_default": true, "evidence_norms": ["github_pr"], "routing_constraints": {}}'::jsonb
  ),
  (
    'board_tasknode_fixes', 'protocol_applications', 'Task Node Fixes',
    'Coordinate defects and hardening work for Task Node.',
    'Turn product defects into reproducible, reviewable repairs.',
    'Configure authorized repositories and contributor routing in the operator environment.',
    'active', 50, 'public_default', 'system', 'Operating',
    '{"inputs": []}'::jsonb,
    '{"public_default": true, "evidence_norms": ["github_pr"], "routing_constraints": {}}'::jsonb
  ),
  (
    'board_capital_markets', 'alpha_generation', 'Capital Markets',
    'Coordinate reviewable capital-markets research.',
    'Turn research questions into sourced, reproducible artifacts.',
    'Configure approved research sources and evidence requirements in the operator environment.',
    'active', 60, 'public_default', 'system', 'Operating',
    '{"inputs": []}'::jsonb,
    '{"public_default": true, "evidence_norms": ["public_link", "document"], "routing_constraints": {}}'::jsonb
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO board_reward_budgets (board_id)
SELECT id
FROM network_projects
WHERE id IN (
  'board_community_promotion',
  'board_pf_terminal',
  'board_postfiat_l1v2',
  'board_ai_l1_governance',
  'board_tasknode_fixes',
  'board_capital_markets'
)
ON CONFLICT (board_id) DO NOTHING;
