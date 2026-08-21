-- The six operator-seeded boards are always visible on the Hive surface,
-- including before their first task exists. Uses the existing operator-pin
-- semantic honored by projectHasBoardEvidence/projectVisibleOnActiveBoard.

UPDATE network_projects
SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || jsonb_build_object(
      'operator_pinned', true,
      'pin_source', 'operator'
    ),
    updated_at = now()
WHERE id IN (
  'board_community_promotion',
  'board_pf_terminal',
  'board_postfiat_l1v2',
  'board_ai_l1_governance',
  'board_tasknode_fixes',
  'board_capital_markets'
);
