CREATE TEMP TABLE garbage_task_projection_ids ON COMMIT DROP AS
SELECT task_id
FROM task_projections
WHERE source = 'pftl_cache_reducer'
  AND status = 'unknown'
  AND COALESCE(title, '') = ''
  AND COALESCE(description, '') = ''
  AND COALESCE(request_id, '') = ''
  AND COALESCE(metadata_json->'generatedTask'->>'title', '') = ''
  AND COALESCE(metadata_json->'generatedTask'->>'description', '') = '';

DELETE FROM pftl_task_pointer_events
WHERE task_id IN (SELECT task_id FROM garbage_task_projection_ids)
  AND COALESCE(event_schema, '') = '';

DELETE FROM task_events
WHERE task_id IN (SELECT task_id FROM garbage_task_projection_ids)
  AND COALESCE(event_type, '') = '';

DELETE FROM task_projections
WHERE task_id IN (SELECT task_id FROM garbage_task_projection_ids);
