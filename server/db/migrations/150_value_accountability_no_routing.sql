-- Value accountability tasks are issued only by scripts/value-accountability.mjs;
-- the board manager must never be asked to route ordinary work to this board.
UPDATE network_projects
   SET metadata_json = jsonb_set(coalesce(metadata_json, '{}'::jsonb), '{routing_constraints}',
         coalesce(metadata_json->'routing_constraints', '{}'::jsonb) || '{"routing_disabled": true}'::jsonb, true),
       updated_at = now()
 WHERE id = 'board_value_accountability';
