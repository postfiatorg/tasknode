-- New validators are Layer 1 work (operator decision 2026-11-25). The durable
-- badge catalog is what task creation reads, so the work type is added here as
-- well as in server/repositories/network-badges.js.
UPDATE network_badge_definitions
   SET allowed_work_types_json = allowed_work_types_json || '["validator_setup"]'::jsonb
 WHERE badge_id IN ('core_contributor', 'validator')
   AND NOT allowed_work_types_json ? 'validator_setup';
