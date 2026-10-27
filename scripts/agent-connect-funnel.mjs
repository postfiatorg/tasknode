#!/usr/bin/env node
// Daily agent-connect funnel from the device sign-in tables (read-only):
// device codes issued, approved and expired, devices that made a first tool
// call, and the median minutes from code to first call. Target: 80% of issued
// codes reach a first tool call within 5 minutes.
//   DATABASE_URL=… node scripts/agent-connect-funnel.mjs [days]
import pg from "pg";

const days = Math.max(1, Math.min(90, Number(process.argv[2]) || 14));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("SET default_transaction_read_only = on");
  const { rows } = await client.query(
    `WITH codes AS (
       SELECT date_trunc('day', r.created_at)::date AS day, r.created_at, r.completed_at, r.status, r.consumed_at, r.expires_at,
              r.request_json->'device'->>'deviceName' AS device_name, r.account_id
         FROM terminal_auth_requests r
        WHERE r.request_json ? 'device' AND COALESCE(r.request_json->'device'->>'clientName', '') <> 'manual token'
          AND r.created_at > now() - make_interval(days => $1)
     ), first_calls AS (
       SELECT s.account_id, s.created_at, s.first_used_at FROM terminal_sessions s
        WHERE s.created_at > now() - make_interval(days => $1) AND s.device_label <> ''
     )
     SELECT c.day,
            count(*) AS issued,
            count(*) FILTER (WHERE c.status = 'linked') AS approved,
            count(*) FILTER (WHERE c.status = 'failed') AS denied,
            count(*) FILTER (WHERE c.status = 'pending' AND c.expires_at < now()) AS expired,
            count(f.first_used_at) AS first_call,
            count(*) FILTER (WHERE f.first_used_at - c.created_at <= interval '5 minutes') AS first_call_5m,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM f.first_used_at - c.created_at) / 60)::numeric, 1) AS median_minutes
       FROM codes c
       LEFT JOIN LATERAL (
         SELECT fc.first_used_at FROM first_calls fc
          WHERE fc.account_id = c.account_id AND c.consumed_at IS NOT NULL AND fc.created_at BETWEEN c.consumed_at - interval '5 seconds' AND c.consumed_at + interval '5 seconds'
          LIMIT 1
       ) f ON true
      GROUP BY c.day ORDER BY c.day DESC`,
    [days]
  );
  console.table(rows.map((row) => ({ ...row, reached_5m: row.issued ? `${Math.round((Number(row.first_call_5m) / Number(row.issued)) * 100)}%` : "-" })));
} finally {
  await client.end();
}
