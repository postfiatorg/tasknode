import { closePool, query } from "../server/db/pool.js";
import { getNetworkTaskEligibility } from "../server/repositories/network-tasks.js";
import {
  listUserObservabilityEvents,
  recordUserObservabilityEvent,
  resolveUserIdentityVector,
  userObservabilitySince,
} from "../server/repositories/user-observability.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

function argValue(name, fallback = "") {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1) return process.argv[index + 1] || fallback;
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function printUsage() {
  console.log([
    "Usage: npm run user-observability -- --handle <hive_handle> [--since today] [--include-events]",
    "       npm run user-observability -- --account-id <account_id> [--since 7d] [--include-events]",
    "       npm run user-observability -- --wallet <classic_address> [--since 2026-06-01]",
    "",
    "Read-only by default user observability packet for identity, wallets, rewards, tasks, memory, profile, Hive, Telegram, usage, and blockers.",
    "Pass --record-resolution when the support lookup itself needs a stored user.identity.resolved audit event.",
    "Pass --record-capacity-checks when Network Task eligibility checks should be stored as user.network_task.capacity_checked events.",
    "Examples:",
    "  npm run user-observability -- --handle goodalexander --since today --include-events",
    "  npm run user-observability -- --wallet rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx --since 7d --pretty",
    "  npm run user-observability -- --account-id acct_oauth_... --record-resolution --pretty",
    "  npm run user-observability -- --account-id acct_oauth_... --record-capacity-checks --pretty",
  ].join("\n"));
}

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function safeQuery(sql, params = []) {
  try {
    const result = await query(sql, params);
    return result.rows;
  } catch (error) {
    return [{ error: error?.message || String(error) }];
  }
}

function okRows(rows = []) {
  return safeArray(rows).filter((row) => !row.error);
}

function sumRows(rows = [], key = "") {
  return okRows(rows).reduce((total, row) => total + numberValue(row[key], 0), 0);
}

async function taskBehavior({ accountId = "", walletAddresses = [], sinceIso = "", limit = 20 } = {}) {
  const wallets = walletAddresses.filter(Boolean);
  const rows = await safeQuery(
    `
      SELECT
        account_id,
        subject_wallet AS wallet_address,
        COALESCE(NULLIF(task_kind, ''), 'unknown') AS task_kind,
        count(*)::int AS offered_count,
        count(*) FILTER (WHERE status IN ('accepted', 'submitted', 'verification_requested', 'verification_response_submitted', 'rewarded'))::int AS accepted_count,
        count(*) FILTER (WHERE status = 'refused')::int AS refused_count,
        count(*) FILTER (WHERE status = 'expired')::int AS expired_count,
        count(*) FILTER (WHERE status IN ('submitted', 'verification_requested', 'verification_response_submitted', 'rewarded'))::int AS submitted_count,
        count(*) FILTER (WHERE status = 'rewarded')::int AS rewarded_count,
        COALESCE(sum(reward_actual_pft) FILTER (WHERE reward_actual_pft > 0), 0)::text AS reward_pft,
        min(created_at) AS first_task_at,
        max(updated_at) AS latest_task_at
      FROM task_projections
      WHERE ($1::text <> '' AND account_id = $1 OR subject_wallet = ANY($2::text[]))
        AND ($3::timestamptz IS NULL OR updated_at >= $3::timestamptz)
      GROUP BY account_id, subject_wallet, COALESCE(NULLIF(task_kind, ''), 'unknown')
      ORDER BY max(updated_at) DESC NULLS LAST
      LIMIT $4
    `,
    [accountId, wallets, sinceIso || null, Math.min(Math.max(Number(limit || 20), 1), 100)]
  );
  const recent = await safeQuery(
    `
      SELECT task_id, account_id, subject_wallet, request_id, status, title, task_kind,
             reward_offer_pft::text AS reward_offer_pft,
             reward_actual_pft::text AS reward_actual_pft,
             last_event_tx_hash, last_event_cid, updated_at
      FROM task_projections
      WHERE ($1::text <> '' AND account_id = $1 OR subject_wallet = ANY($2::text[]))
        AND ($3::timestamptz IS NULL OR updated_at >= $3::timestamptz)
      ORDER BY updated_at DESC, task_id DESC
      LIMIT $4
    `,
    [accountId, wallets, sinceIso || null, Math.min(Math.max(Number(limit || 20), 1), 100)]
  );
  const cleanRows = okRows(rows).map((row) => ({
    accountId: row.account_id,
    walletAddress: row.wallet_address,
    taskKind: row.task_kind,
    offeredCount: numberValue(row.offered_count),
    acceptedCount: numberValue(row.accepted_count),
    refusedCount: numberValue(row.refused_count),
    expiredCount: numberValue(row.expired_count),
    submittedCount: numberValue(row.submitted_count),
    rewardedCount: numberValue(row.rewarded_count),
    rewardPft: numberValue(row.reward_pft),
    refusalRate: numberValue(row.offered_count) > 0 ? numberValue(row.refused_count) / numberValue(row.offered_count) : 0,
    firstTaskAt: toIso(row.first_task_at),
    latestTaskAt: toIso(row.latest_task_at),
  }));
  return {
    byKindAndWallet: cleanRows,
    totals: {
      offeredCount: sumRows(cleanRows, "offeredCount"),
      acceptedCount: sumRows(cleanRows, "acceptedCount"),
      refusedCount: sumRows(cleanRows, "refusedCount"),
      expiredCount: sumRows(cleanRows, "expiredCount"),
      submittedCount: sumRows(cleanRows, "submittedCount"),
      rewardedCount: sumRows(cleanRows, "rewardedCount"),
      rewardPft: sumRows(cleanRows, "rewardPft"),
    },
    recentTasks: okRows(recent).map((row) => ({
      taskId: row.task_id,
      accountId: row.account_id,
      walletAddress: row.subject_wallet,
      requestId: row.request_id,
      status: row.status,
      title: row.title,
      taskKind: row.task_kind,
      rewardOfferPft: numberValue(row.reward_offer_pft),
      rewardActualPft: numberValue(row.reward_actual_pft),
      lastEventTxHash: row.last_event_tx_hash,
      lastEventCid: row.last_event_cid,
      updatedAt: toIso(row.updated_at),
    })),
    queryErrors: [...rows, ...recent].filter((row) => row.error),
  };
}

async function rewards({ accountId = "", walletAddresses = [], sinceIso = "" } = {}) {
  const rows = await safeQuery(
    `
      SELECT account_id, wallet_address, day,
             task_reward_pft::text AS task_reward_pft,
             daily_airdrop_pft::text AS daily_airdrop_pft,
             initiation_grant_pft::text AS initiation_grant_pft,
             top_up_credit_usd::text AS top_up_credit_usd
      FROM user_reward_rollups
      WHERE ($1::text <> '' AND account_id = $1 OR wallet_address = ANY($2::text[]))
        AND ($3::date IS NULL OR day >= $3::date)
      ORDER BY day DESC, wallet_address ASC
      LIMIT 120
    `,
    [accountId, walletAddresses.filter(Boolean), sinceIso ? sinceIso.slice(0, 10) : null]
  );
  const cleanRows = okRows(rows).map((row) => ({
    accountId: row.account_id,
    walletAddress: row.wallet_address,
    day: row.day,
    taskRewardPft: numberValue(row.task_reward_pft),
    dailyAirdropPft: numberValue(row.daily_airdrop_pft),
    initiationGrantPft: numberValue(row.initiation_grant_pft),
    topUpCreditUsd: numberValue(row.top_up_credit_usd),
  }));
  return {
    byDay: cleanRows,
    totals: {
      taskRewardPft: sumRows(cleanRows, "taskRewardPft"),
      dailyAirdropPft: sumRows(cleanRows, "dailyAirdropPft"),
      initiationGrantPft: sumRows(cleanRows, "initiationGrantPft"),
      topUpCreditUsd: sumRows(cleanRows, "topUpCreditUsd"),
    },
    queryErrors: rows.filter((row) => row.error),
  };
}

async function usagePacket({ accountId = "", sinceIso = "" } = {}) {
  const [messages, modelRuns, conversations, eventUsage] = await Promise.all([
    safeQuery(
      `
        SELECT role, count(*)::int AS count, max(created_at) AS latest_at
        FROM chat_messages
        WHERE account_id = $1
          AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
        GROUP BY role
      `,
      [accountId, sinceIso || null]
    ),
    safeQuery(
      `
        SELECT status, count(*)::int AS count,
               COALESCE(sum(total_tokens), 0)::int AS total_tokens,
               COALESCE(sum(total_cost_usd), 0)::text AS total_cost_usd,
               max(started_at) AS latest_at
        FROM chat_model_runs
        WHERE account_id = $1
          AND ($2::timestamptz IS NULL OR started_at >= $2::timestamptz)
        GROUP BY status
      `,
      [accountId, sinceIso || null]
    ),
    safeQuery(
      `
        SELECT count(*)::int AS conversation_count,
               count(*) FILTER (WHERE status = 'active')::int AS active_conversation_count,
               max(updated_at) AS latest_at
        FROM chat_conversations
        WHERE account_id = $1
          AND ($2::timestamptz IS NULL OR updated_at >= $2::timestamptz)
      `,
      [accountId, sinceIso || null]
    ),
    safeQuery(
      `
        SELECT *
        FROM user_daily_usage_rollups
        WHERE account_id = $1
          AND ($2::date IS NULL OR day >= $2::date)
        ORDER BY day DESC
        LIMIT 30
      `,
      [accountId, sinceIso ? sinceIso.slice(0, 10) : null]
    ),
  ]);
  const messageRows = okRows(messages);
  const modelRows = okRows(modelRuns);
  const conversation = okRows(conversations)[0] || {};
  return {
    chatMessagesByRole: Object.fromEntries(messageRows.map((row) => [row.role, numberValue(row.count)])),
    latestChatMessageAt: toIso(messageRows.map((row) => row.latest_at).filter(Boolean).sort().at(-1)),
    modelRunsByStatus: modelRows.map((row) => ({
      status: row.status,
      count: numberValue(row.count),
      totalTokens: numberValue(row.total_tokens),
      totalCostUsd: numberValue(row.total_cost_usd),
      latestAt: toIso(row.latest_at),
    })),
    conversations: {
      count: numberValue(conversation.conversation_count),
      activeCount: numberValue(conversation.active_conversation_count),
      latestAt: toIso(conversation.latest_at),
    },
    observabilityRollups: okRows(eventUsage).map((row) => ({
      day: row.day,
      sessionCount: numberValue(row.session_count),
      activeSurfaceCount: numberValue(row.active_surface_count),
      chatMessageCount: numberValue(row.chat_message_count),
      modelRunCount: numberValue(row.model_run_count),
      taskActionCount: numberValue(row.task_action_count),
      hiveActionCount: numberValue(row.hive_action_count),
      telegramEventCount: numberValue(row.telegram_event_count),
      topUpEventCount: numberValue(row.top_up_event_count),
      firstSeenAt: toIso(row.first_seen_at),
      lastSeenAt: toIso(row.last_seen_at),
    })),
    queryErrors: [...messages, ...modelRuns, ...conversations, ...eventUsage].filter((row) => row.error),
  };
}

async function memoryPacket({ accountId = "", sinceIso = "" } = {}) {
  const [memoryRows, deepRows, profileRows, profileJobs] = await Promise.all([
    safeQuery(
      `
        SELECT kind, count(*)::int AS count, max(created_at) AS latest_at
        FROM chat_memory_entries
        WHERE account_id = $1
          AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
        GROUP BY kind
      `,
      [accountId, sinceIso || null]
    ),
    safeQuery(
      `
        SELECT id, block_index, status, attempt_count, last_error, created_at, updated_at
        FROM chat_deep_memory_jobs
        WHERE account_id = $1
        ORDER BY updated_at DESC, id DESC
        LIMIT 5
      `,
      [accountId]
    ),
    safeQuery(
      `
        SELECT id, status, source_packet_digest, prompt_version, prompt_digest,
               completed_at, created_at, error
        FROM network_task_profiles
        WHERE account_id = $1
        ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
        LIMIT 5
      `,
      [accountId]
    ),
    safeQuery(
      `
        SELECT id, status, reason, source_packet_digest, attempt_count, last_error, created_at, updated_at
        FROM network_task_profile_jobs
        WHERE account_id = $1
        ORDER BY updated_at DESC, id DESC
        LIMIT 5
      `,
      [accountId]
    ),
  ]);
  return {
    memoryEntryCounts: okRows(memoryRows).map((row) => ({
      kind: row.kind,
      count: numberValue(row.count),
      latestAt: toIso(row.latest_at),
    })),
    deepMemoryJobs: okRows(deepRows).map((row) => ({
      id: row.id,
      blockIndex: row.block_index,
      status: row.status,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    })),
    networkProfiles: okRows(profileRows).map((row) => ({
      id: row.id,
      status: row.status,
      sourcePacketDigest: row.source_packet_digest,
      promptVersion: row.prompt_version,
      promptDigest: row.prompt_digest,
      completedAt: toIso(row.completed_at),
      createdAt: toIso(row.created_at),
      error: row.error,
    })),
    networkProfileJobs: okRows(profileJobs).map((row) => ({
      id: row.id,
      status: row.status,
      reason: row.reason,
      sourcePacketDigest: row.source_packet_digest,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    })),
    queryErrors: [...memoryRows, ...deepRows, ...profileRows, ...profileJobs].filter((row) => row.error),
  };
}

async function profilePacket({ accountId = "", walletAddresses = [] } = {}) {
  const [snapshots, nfts, recommendations] = await Promise.all([
    safeQuery(
      `
        SELECT snapshot_id, status, role_title, prompt_version, prompt_digest,
               completed_at, updated_at, error_message
        FROM profile_public_snapshots
        WHERE account_id = $1
        ORDER BY completed_at DESC NULLS LAST, updated_at DESC, snapshot_id DESC
        LIMIT 5
      `,
      [accountId]
    ),
    safeQuery(
      `
        SELECT wallet_address, status, count(*)::int AS count, max(updated_at) AS latest_at
        FROM profile_nfts
        WHERE account_id = $1
           OR wallet_address = ANY($2::text[])
        GROUP BY wallet_address, status
        ORDER BY max(updated_at) DESC
        LIMIT 30
      `,
      [accountId, walletAddresses.filter(Boolean)]
    ),
    safeQuery(
      `
        SELECT account_id, wallet_address, hive_handle, display_name, discoverable,
               network_profile_id, network_profile_digest, generated_at, disabled_at
        FROM recommended_connection_profiles
        WHERE account_id = $1
        LIMIT 1
      `,
      [accountId]
    ),
  ]);
  return {
    publicSnapshots: okRows(snapshots).map((row) => ({
      snapshotId: row.snapshot_id,
      status: row.status,
      roleTitle: row.role_title,
      promptVersion: row.prompt_version,
      promptDigest: row.prompt_digest,
      completedAt: toIso(row.completed_at),
      updatedAt: toIso(row.updated_at),
      error: row.error_message,
    })),
    nftsByWalletAndStatus: okRows(nfts).map((row) => ({
      walletAddress: row.wallet_address,
      status: row.status,
      count: numberValue(row.count),
      latestAt: toIso(row.latest_at),
    })),
    recommendedConnectionProfile: okRows(recommendations)[0] ? {
      accountId: recommendations[0].account_id,
      walletAddress: recommendations[0].wallet_address,
      hiveHandle: recommendations[0].hive_handle,
      displayName: recommendations[0].display_name,
      discoverable: recommendations[0].discoverable === true,
      networkProfileId: recommendations[0].network_profile_id,
      networkProfileDigest: recommendations[0].network_profile_digest,
      generatedAt: toIso(recommendations[0].generated_at),
      disabledAt: toIso(recommendations[0].disabled_at),
    } : null,
    queryErrors: [...snapshots, ...nfts, ...recommendations].filter((row) => row.error),
  };
}

async function telegramPacket({ accountId = "", sinceIso = "" } = {}) {
  const rows = await safeQuery(
    `
      SELECT event_type, direction, action, status, count(*)::int AS count, max(created_at) AS latest_at
      FROM telegram_bot_events
      WHERE account_id = $1
        AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
      GROUP BY event_type, direction, action, status
      ORDER BY max(created_at) DESC
      LIMIT 40
    `,
    [accountId, sinceIso || null]
  );
  return {
    linked: false,
    events: okRows(rows).map((row) => ({
      eventType: row.event_type,
      direction: row.direction,
      action: row.action,
      status: row.status,
      count: numberValue(row.count),
      latestAt: toIso(row.latest_at),
    })),
    queryErrors: rows.filter((row) => row.error),
  };
}

async function hivePacket({ accountId = "", sinceIso = "" } = {}) {
  const [contextRows, messages, followups] = await Promise.all([
    safeQuery(
      `
        SELECT count(*)::int AS count, max(created_at) AS latest_at
        FROM hive_context_entries
        WHERE account_id = $1
          AND deleted_at IS NULL
          AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
      `,
      [accountId, sinceIso || null]
    ),
    safeQuery(
      `
        SELECT status, count(*)::int AS count, max(created_at) AS latest_at, max(read_at) AS latest_read_at
        FROM board_manager_user_messages
        WHERE account_id = $1
          AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
        GROUP BY status
      `,
      [accountId, sinceIso || null]
    ),
    safeQuery(
      `
        SELECT status, count(*)::int AS count, max(updated_at) AS latest_at
        FROM board_manager_followups
        WHERE account_id = $1
          AND ($2::timestamptz IS NULL OR updated_at >= $2::timestamptz)
        GROUP BY status
      `,
      [accountId, sinceIso || null]
    ),
  ]);
  const context = okRows(contextRows)[0] || {};
  return {
    contextEntries: {
      count: numberValue(context.count),
      latestAt: toIso(context.latest_at),
    },
    boardMessagesByStatus: okRows(messages).map((row) => ({
      status: row.status,
      count: numberValue(row.count),
      latestAt: toIso(row.latest_at),
      latestReadAt: toIso(row.latest_read_at),
    })),
    followupsByStatus: okRows(followups).map((row) => ({
      status: row.status,
      count: numberValue(row.count),
      latestAt: toIso(row.latest_at),
    })),
    queryErrors: [...contextRows, ...messages, ...followups].filter((row) => row.error),
  };
}

async function timelinePacket({ accountId = "", walletAddresses = [], sinceIso = "", limit = 40, includeStoredEvents = false } = {}) {
  const wallets = walletAddresses.filter(Boolean);
  const [
    taskRequests,
    taskEvents,
    chatMessages,
    modelRuns,
    profileEvents,
    memoryEvents,
    hiveEvents,
    telegramEvents,
    storedEvents,
  ] = await Promise.all([
    safeQuery(
      `
        SELECT request_id, account_id, subject_wallet, requested_task_kind, status,
               generated_task_id, request_tx_hash, request_event_cid, updated_at, created_at
        FROM task_requests
        WHERE ($1::text <> '' AND account_id = $1 OR subject_wallet = ANY($2::text[]))
          AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz OR updated_at >= $3::timestamptz)
        ORDER BY updated_at DESC, created_at DESC
        LIMIT $4
      `,
      [accountId, wallets, sinceIso || null, limit]
    ),
    safeQuery(
      `
        SELECT task_id, account_id, wallet_address, event_type, source_tx_hash, source_cid,
               payload_json, occurred_at, created_at
        FROM task_events
        WHERE ($1::text <> '' AND account_id = $1 OR wallet_address = ANY($2::text[]))
          AND ($3::timestamptz IS NULL OR occurred_at >= $3::timestamptz)
        ORDER BY occurred_at DESC, id DESC
        LIMIT $4
      `,
      [accountId, wallets, sinceIso || null, limit]
    ),
    safeQuery(
      `
        SELECT id, conversation_id, account_id, role, mode, created_at
        FROM chat_messages
        WHERE account_id = $1
          AND role = 'user'
          AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
        ORDER BY created_at DESC, message_order DESC
        LIMIT $3
      `,
      [accountId, sinceIso || null, limit]
    ),
    safeQuery(
      `
        SELECT id, conversation_id, account_id, status, provider, model, mode,
               total_tokens, total_cost_usd::text AS total_cost_usd, started_at, completed_at
        FROM chat_model_runs
        WHERE account_id = $1
          AND ($2::timestamptz IS NULL OR started_at >= $2::timestamptz)
        ORDER BY started_at DESC, id DESC
        LIMIT $3
      `,
      [accountId, sinceIso || null, limit]
    ),
    safeQuery(
      `
        SELECT snapshot_id AS id, account_id, status, role_title, 'profile_public_snapshot' AS source,
               updated_at AS occurred_at, completed_at
        FROM profile_public_snapshots
        WHERE account_id = $1
          AND ($2::timestamptz IS NULL OR updated_at >= $2::timestamptz)
        UNION ALL
        SELECT id, account_id, status, title AS role_title, 'profile_nft' AS source,
               updated_at AS occurred_at, COALESCE(minted_at, generated_at, updated_at) AS completed_at
        FROM profile_nfts
        WHERE (account_id = $1 OR wallet_address = ANY($3::text[]))
          AND ($2::timestamptz IS NULL OR updated_at >= $2::timestamptz)
        ORDER BY occurred_at DESC
        LIMIT $4
      `,
      [accountId, sinceIso || null, wallets, limit]
    ),
    safeQuery(
      `
        SELECT id, account_id, status, source_packet_digest, 'network_task_profile' AS source,
               COALESCE(completed_at, created_at) AS occurred_at
        FROM network_task_profiles
        WHERE account_id = $1
          AND ($2::timestamptz IS NULL OR COALESCE(completed_at, created_at) >= $2::timestamptz)
        UNION ALL
        SELECT id, account_id, status, source_packet_digest, 'network_task_profile_job' AS source,
               updated_at AS occurred_at
        FROM network_task_profile_jobs
        WHERE account_id = $1
          AND ($2::timestamptz IS NULL OR updated_at >= $2::timestamptz)
        ORDER BY occurred_at DESC
        LIMIT $3
      `,
      [accountId, sinceIso || null, limit]
    ),
    safeQuery(
      `
        SELECT id, account_id, 'hive_context_submitted' AS source, source_conversation_id,
               '' AS project_id, created_at AS occurred_at, '' AS status
        FROM hive_context_entries
        WHERE account_id = $1
          AND deleted_at IS NULL
          AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
        UNION ALL
        SELECT id, account_id, 'board_message_delivered' AS source, '' AS source_conversation_id,
               '' AS project_id, created_at AS occurred_at, status
        FROM board_manager_user_messages
        WHERE account_id = $1
          AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
        UNION ALL
        SELECT id, account_id, 'board_followup' AS source, conversation_id AS source_conversation_id,
               project_id, updated_at AS occurred_at, status
        FROM board_manager_followups
        WHERE account_id = $1
          AND ($2::timestamptz IS NULL OR updated_at >= $2::timestamptz)
        ORDER BY occurred_at DESC
        LIMIT $3
      `,
      [accountId, sinceIso || null, limit]
    ),
    safeQuery(
      `
        SELECT id, account_id, event_type, direction, action, status, created_at
        FROM telegram_bot_events
        WHERE account_id = $1
          AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
        ORDER BY created_at DESC, id DESC
        LIMIT $3
      `,
      [accountId, sinceIso || null, limit]
    ),
    includeStoredEvents
      ? listUserObservabilityEvents({ accountId, since: sinceIso || "", limit })
      : Promise.resolve([]),
  ]);

  const events = [];
  for (const row of okRows(taskRequests)) {
    events.push({
      occurredAt: toIso(row.updated_at || row.created_at),
      eventType: "user.task.request_published",
      accountId: row.account_id,
      walletAddress: row.subject_wallet,
      requestId: row.request_id,
      taskId: row.generated_task_id,
      status: row.status,
      taskKind: row.requested_task_kind,
      txHash: row.request_tx_hash,
      cid: row.request_event_cid,
      source: "task_requests",
    });
  }
  for (const row of okRows(taskEvents)) {
    const transition = row.payload_json?.transition || row.payload_json?.status_after || "";
    const eventType = row.event_type === "pf.task.offer.v1"
      ? "user.task.offer_visible"
      : row.event_type === "pf.reward.v1"
        ? "user.task.reward_projected"
        : row.event_type === "pf.task.submission.v1"
          ? "user.task.submission_published"
          : transition === "verification_requested"
            ? "user.task.verification_requested"
            : "user.task.action_published";
    events.push({
      occurredAt: toIso(row.occurred_at || row.created_at),
      eventType,
      accountId: row.account_id,
      walletAddress: row.wallet_address,
      taskId: row.task_id,
      status: transition,
      txHash: row.source_tx_hash,
      cid: row.source_cid,
      source: "task_events",
    });
  }
  for (const row of okRows(chatMessages)) {
    events.push({
      occurredAt: toIso(row.created_at),
      eventType: "user.chat.message_sent",
      accountId: row.account_id,
      conversationId: row.conversation_id,
      status: "sent",
      source: "chat_messages",
      metadata: { mode: row.mode || "" },
    });
  }
  for (const row of okRows(modelRuns)) {
    events.push({
      occurredAt: toIso(row.completed_at || row.started_at),
      eventType: row.status === "completed" ? "user.chat.model_run_completed" : "user.chat.model_run_failed",
      accountId: row.account_id,
      conversationId: row.conversation_id,
      modelRunId: row.id,
      status: row.status,
      source: "chat_model_runs",
      metrics: {
        totalTokens: numberValue(row.total_tokens),
        totalCostUsd: numberValue(row.total_cost_usd),
      },
      metadata: { provider: row.provider, model: row.model, mode: row.mode },
    });
  }
  for (const row of okRows(profileEvents)) {
    events.push({
      occurredAt: toIso(row.completed_at || row.occurred_at),
      eventType: row.source === "profile_nft" ? "user.profile.nft_generated" : "user.profile.public_snapshot_completed",
      accountId: row.account_id,
      status: row.status,
      source: row.source,
      metadata: { id: row.id, title: row.role_title || "" },
    });
  }
  for (const row of okRows(memoryEvents)) {
    events.push({
      occurredAt: toIso(row.occurred_at),
      eventType: row.source === "network_task_profile_job"
        ? "user.memory.network_profile_queued"
        : row.status === "failed"
          ? "user.memory.network_profile_failed"
          : "user.memory.network_profile_completed",
      accountId: row.account_id,
      status: row.status,
      source: row.source,
      metadata: { id: row.id, sourcePacketDigest: row.source_packet_digest || "" },
    });
  }
  for (const row of okRows(hiveEvents)) {
    const eventType = row.source === "hive_context_submitted"
      ? "user.hive.context_submitted"
      : row.source === "board_message_delivered"
        ? row.status === "read" ? "user.hive.board_message_read" : "user.hive.board_message_delivered"
        : ["answered", "resolved"].includes(row.status) ? "user.hive.followup_closed" : "user.hive.followup_opened";
    events.push({
      occurredAt: toIso(row.occurred_at),
      eventType,
      accountId: row.account_id,
      conversationId: row.source_conversation_id,
      projectId: row.project_id,
      status: row.status,
      source: row.source,
      metadata: { id: row.id },
    });
  }
  for (const row of okRows(telegramEvents)) {
    events.push({
      occurredAt: toIso(row.created_at),
      eventType: row.direction === "inbound" ? "user.telegram.bot_message_received" : row.status === "failed" ? "user.telegram.webhook_failed" : "user.telegram.bot_response_sent",
      accountId: row.account_id,
      status: row.status,
      source: "telegram_bot_events",
      metadata: { id: row.id, telegramEventType: row.event_type, direction: row.direction, action: row.action },
    });
  }
  for (const row of safeArray(storedEvents)) {
    events.push({
      occurredAt: row.occurredAt,
      eventType: row.eventType,
      accountId: row.accountId,
      walletAddress: row.walletAddress,
      requestId: row.requestId,
      taskId: row.taskId,
      projectId: row.projectId,
      allocationId: row.allocationId,
      generationJobId: row.generationJobId,
      status: row.resultStatus,
      source: "user_observability_events",
      reasonCode: row.reasonCode,
      decision: row.decision,
      metrics: row.metrics,
      metadata: { id: row.id, ...row.metadata },
    });
  }

  return events
    .filter((event) => event.occurredAt)
    .sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt)))
    .slice(0, Math.min(Math.max(Number(limit || 40), 1), 200));
}

async function networkEligibility(identity = {}, { recordCapacityChecks = false } = {}) {
  const wallets = safeArray(identity.wallets).filter((wallet) => wallet.walletAddress && wallet.status === "active");
  const candidates = wallets.length ? wallets : safeArray(identity.wallets).filter((wallet) => wallet.walletAddress).slice(0, 2);
  const checks = [];
  for (const wallet of candidates) {
    const eligibility = await getNetworkTaskEligibility({
      accountId: identity.accountId || "",
      walletAddress: wallet.walletAddress,
      recordCapacityEvent: recordCapacityChecks,
    }).catch((error) => ({
      status: "unavailable",
      error: error?.message || String(error),
      accountId: identity.accountId || "",
      walletAddress: wallet.walletAddress,
    }));
    checks.push({
      walletAddress: wallet.walletAddress,
      walletStatus: wallet.status,
      eligibility,
    });
  }
  return checks;
}

async function main() {
  if (hasFlag("help") || hasFlag("h")) {
    printUsage();
    return;
  }

  const handle = argValue("handle");
  const accountId = argValue("account-id");
  const walletAddress = argValue("wallet");
  const provider = argValue("provider");
  const providerUsername = argValue("provider-username");
  const sinceInput = argValue("since", "today");
  const sinceIso = userObservabilitySince(sinceInput);
  const limit = Math.min(Math.max(Number(argValue("limit", "20")) || 20, 1), 100);
  const includeEvents = hasFlag("include-events");
  const recordResolution = hasFlag("record-resolution");
  const recordCapacityChecks = hasFlag("record-capacity-checks");

  const resolved = await resolveUserIdentityVector({ handle, accountId, walletAddress, provider, providerUsername });
  if (!resolved.ok) {
    console.error(JSON.stringify({ ok: false, ...resolved }, null, 2));
    process.exitCode = 1;
    return;
  }

  const identity = resolved.identity || {};
  const walletAddresses = safeArray(identity.wallets).map((wallet) => wallet.walletAddress).filter(Boolean);
  const resolutionEvent = recordResolution
    ? await recordUserObservabilityEvent({
        eventType: "user.identity.resolved",
        accountId: identity.accountId || "",
        walletAddress: walletAddress || walletAddresses[0] || "",
        walletScope: walletAddress ? "unknown" : walletAddresses[0] ? "active" : "",
        sourceSurface: "operator",
        sourceRoute: "scripts/user-observability.mjs",
        resultStatus: "resolved",
        reasonCode: resolved.warning || "",
        decision: {
          selector: resolved.selector || {},
          match_count: safeArray(resolved.matches).length,
          identity_warning: resolved.warning || "",
        },
        metrics: {
          walletCount: walletAddresses.length,
          providerCount: safeArray(identity.providers).length,
        },
        metadata: {
          sinceInput,
          includeEvents,
          recordCapacityChecks,
          limit,
          selectorTypes: [
            handle ? "handle" : "",
            accountId ? "account_id" : "",
            walletAddress ? "wallet" : "",
            provider ? "provider" : "",
            providerUsername ? "provider_username" : "",
          ].filter(Boolean),
        },
      })
    : null;
  const [
    usage,
    task,
    reward,
    memory,
    profile,
    telegram,
    hive,
    networkTasks,
    recentEvents,
  ] = await Promise.all([
    usagePacket({ accountId: identity.accountId, sinceIso }),
    taskBehavior({ accountId: identity.accountId, walletAddresses, sinceIso, limit }),
    rewards({ accountId: identity.accountId, walletAddresses, sinceIso }),
    memoryPacket({ accountId: identity.accountId, sinceIso }),
    profilePacket({ accountId: identity.accountId, walletAddresses }),
    telegramPacket({ accountId: identity.accountId, sinceIso }),
    hivePacket({ accountId: identity.accountId, sinceIso }),
    networkEligibility(identity, { recordCapacityChecks }),
    includeEvents
      ? listUserObservabilityEvents({
          accountId: identity.accountId,
          walletAddress: walletAddress || "",
          since: sinceInput,
          limit,
        })
      : Promise.resolve([]),
  ]);

  const timeline = await timelinePacket({
    accountId: identity.accountId,
    walletAddresses,
    sinceIso,
    limit: Math.max(limit, 40),
    includeStoredEvents: includeEvents,
  });

  const providerNames = new Set(safeArray(identity.providers).map((item) => item.provider));
  telegram.linked = providerNames.has("telegram") || telegram.events.length > 0;

  const packet = {
    ok: true,
    generatedAt: new Date().toISOString(),
    selector: resolved.selector,
    timeWindow: {
      sinceInput,
      sinceIso,
    },
    identity,
    summary: {
      accountId: identity.accountId,
      publicHandle: identity.publicHandle,
      activeWallets: walletAddresses.filter((address) => {
        const wallet = safeArray(identity.wallets).find((item) => item.walletAddress === address);
        return wallet?.status === "active";
      }),
      chatMessagesTodayOrWindow: numberValue(usage.chatMessagesByRole.user),
      taskOffersInWindow: task.totals.offeredCount,
      taskRewardsPftInWindow: reward.totals.taskRewardPft,
      dailyAirdropPftInWindow: reward.totals.dailyAirdropPft,
      topUpCreditUsdInWindow: reward.totals.topUpCreditUsd,
      hiveContextEntriesInWindow: hive.contextEntries.count,
      telegramLinked: telegram.linked,
      networkEligibilityStatuses: networkTasks.map((item) => ({
        walletAddress: item.walletAddress,
        status: item.eligibility.status,
        reason: item.eligibility.capacity?.blockers?.length ? "capacity_blocked" : item.eligibility.nextAction || "",
      })),
    },
    usage,
    rewards: reward,
    tasks: task,
    networkTasks,
    timeline,
    memory,
    profile,
    telegram,
    hive,
    recentEvents,
    resolutionEvent: resolutionEvent
      ? {
          recorded: resolutionEvent.ok === true,
          skipped: Boolean(resolutionEvent.skipped),
          eventId: resolutionEvent.id || "",
          reason: resolutionEvent.reason || resolutionEvent.error || "",
        }
      : null,
    sourceNotes: [
      "Task state and task rewards come from task_projections.",
      "Runtime Network Task capacity checks call getNetworkTaskEligibility and emit user.network_task.capacity_checked when Postgres is enabled; this operator packet records those checks only with --record-capacity-checks.",
      "Identity resolution uses runtime-store identity data plus Postgres wallet/task/profile sources when available.",
    ],
  };

  console.log(JSON.stringify(packet, null, 2));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
