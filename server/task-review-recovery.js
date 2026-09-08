import { query } from "./db/pool.js";

// A payment guard is written before any reward transaction is submitted.
// Only abandoned reservations with no guard, no submission evidence and no
// indexed outcome can return to the queue. Uncertain payments remain guarded.
export async function recoverAbandonedReviewPublications({ staleSeconds = 900, limit = 10 } = {}) {
  const result = await query(`
    WITH abandoned AS (
      SELECT pub.task_id, pub.worker_name
      FROM task_review_publications pub
      JOIN task_projections p ON p.task_id=pub.task_id
      WHERE pub.worker_name='reward_scoring' AND pub.status='reserved'
        AND pub.updated_at < now() - ($1::integer * interval '1 second')
        AND pub.source_tx_hash='' AND pub.source_cid=''
        AND COALESCE(pub.metadata_json->>'submission_attempted','false')='false'
        AND (p.metadata_json->'reward_payment_guard' IS NULL OR p.metadata_json->'reward_payment_guard'='{}'::jsonb)
        AND p.status='verification_response_submitted'
        AND NOT EXISTS (SELECT 1 FROM task_events e WHERE e.task_id=p.task_id
          AND e.event_type IN ('pf.reward.v1','pf.task.reward_decision.v1'))
      ORDER BY pub.updated_at LIMIT $2 FOR UPDATE OF pub, p SKIP LOCKED
    )
    UPDATE task_review_publications pub SET status='retry_wait',
      error='abandoned_before_payment', updated_at=now(),
      metadata_json=pub.metadata_json || jsonb_build_object('retry_after',now(),
        'recovered_at',now(),'recovery_reason','abandoned_before_payment')
    FROM abandoned WHERE pub.task_id=abandoned.task_id AND pub.worker_name=abandoned.worker_name
    RETURNING pub.task_id
  `, [Math.max(60, Number(staleSeconds) || 900), Math.min(50, Math.max(1, Number(limit) || 10))]);
  return { recovered: result.rows.map((row) => row.task_id) };
}
