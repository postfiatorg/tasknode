DELETE FROM network_project_activity
WHERE project_id = 'pft_distribution_v3'
  AND id LIKE 'np_activity_pft_v3_%';

DELETE FROM network_project_task_refs
WHERE project_id = 'pft_distribution_v3'
  AND id LIKE 'np_task_pft_v3_%';

DELETE FROM network_project_contributors
WHERE project_id = 'pft_distribution_v3'
  AND wallet_address IN (
    '0x71f...4ab2',
    '0xb35...027e',
    '0xa12...77df',
    '0xc9e...d801',
    '0x10c...8a44',
    '0x9f3...18ee'
  );

DELETE FROM network_projects
WHERE id IN (
  'cross_chain_liquidity_index',
  'operator_onboarding_redesign',
  'conference_circuit_q3',
  'whitepaper_v2_research',
  'alpha_digest_weekly'
)
AND origin = 'system_seed';

UPDATE network_projects
SET source_inputs_json = source_inputs_json || '{
      "inputs": ["hive_secretary_report", "pft_distribution_v3_project_spec"],
      "note": "Project exists before network task allocation; task refs, contributors, and activity attach only after live allocation.",
      "display_metrics": {
        "task_count": "planned_network_task_count",
        "contributor_count": "target_operator_count",
        "pft_routed": "planned_route_budget"
      }
    }'::jsonb,
    updated_at = now()
WHERE id = 'pft_distribution_v3';
