import { databaseEnabled, query } from "../db/pool.js";

const packetStatuses = [
  "proposed",
  "accepted",
  "submitted",
  "verification_requested",
  "verification_response_submitted",
  "reward_decided",
  "rewarded",
  "paid",
];

const proposalStatuses = new Set(["proposed"]);
const outstandingStatuses = new Set([
  "accepted",
  "submitted",
  "verification_requested",
  "verification_response_submitted",
]);
const rewardedStatuses = new Set(["rewarded", "paid", "reward_decided"]);

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function intValue(value, fallback = 24, { min = 1, max = 100 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}

function numeric(value = 0) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function iso(value = null) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function normalizedStatus(value = "") {
  return safeText(value, 80).toLowerCase();
}

function safeArray(value = []) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function formatPft(value = 0) {
  const number = numeric(value);
  if (!number) return "0 PFT";
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: number < 100 ? 2 : 0,
  }).format(number)} PFT`;
}

function compactWallet(value = "") {
  const text = safeText(value, 140);
  if (text.length <= 14) return text || "unknown wallet";
  return `${text.slice(0, 7)}...${text.slice(-6)}`;
}

function compactAccount(value = "") {
  const text = safeText(value, 180);
  if (text.length <= 24) return text || "unknown account";
  return `${text.slice(0, 12)}...${text.slice(-8)}`;
}

function formatStatus(value = "") {
  return safeText(value, 80).replace(/_/g, " ") || "unknown";
}

function lineList(items = [], emptyText = "None.") {
  if (!items.length) return [`- ${emptyText}`];
  return items.map((item) => `- ${item}`);
}

function taskLine(task = {}) {
  const parts = [
    task.title || task.taskId || "Untitled Network Task",
    task.taskId ? `task ${task.taskId}` : "",
    task.projectTitle ? `project ${task.projectTitle}` : "",
    `status ${formatStatus(task.status)}`,
    task.rewardActualPft ? `rewarded ${formatPft(task.rewardActualPft)}` : `offer ${formatPft(task.rewardOfferPft)}`,
    task.updatedAt ? `updated ${task.updatedAt}` : "",
  ].filter(Boolean);
  return parts.join("; ");
}

function contributorLabel(contributor = {}) {
  if (contributor.handle) return `@${contributor.handle.replace(/^@+/, "")}`;
  if (contributor.displayName) return contributor.displayName;
  if (contributor.accountId) return compactAccount(contributor.accountId);
  return compactWallet(contributor.walletAddress);
}

function normalizeTaskRow(row = {}) {
  const walletAddress = safeText(row.wallet_address || row.subject_wallet || row.assignee_wallet, 140);
  const accountId = safeText(row.resolved_account_id || row.account_id, 180);
  const handle = safeText(row.provider_public_handle || row.public_handle || row.identity_public_handle, 120).replace(/^@+/, "");
  const displayName = safeText(
    row.hive_display_name ||
      row.display_name ||
      (handle ? `@${handle}` : "") ||
      row.codename ||
      accountId ||
      walletAddress,
    180
  );
  return {
    taskId: safeText(row.task_id, 180),
    requestId: safeText(row.request_id, 180),
    accountId,
    walletAddress,
    handle,
    displayName,
    status: safeText(row.status, 80),
    normalizedStatus: normalizedStatus(row.status),
    title: safeText(row.title, 260),
    description: safeText(row.description, 1200),
    projectId: safeText(row.project_id, 160),
    projectTitle: safeText(row.project_title, 260),
    rewardOfferPft: numeric(row.reward_offer_pft),
    rewardActualPft: numeric(row.reward_actual_pft),
    updatedAt: iso(row.updated_at || row.last_event_at || row.created_at),
    lastEventAt: iso(row.last_event_at || row.updated_at || row.created_at),
  };
}

function taskSortValue(task = {}) {
  const date = new Date(task.lastEventAt || task.updatedAt || 0).getTime();
  return Number.isFinite(date) ? date : 0;
}

function contributorSortValue(contributor = {}) {
  const liveScore = contributor.outstanding.length ? 3 : contributor.proposals.length ? 2 : 0;
  return [liveScore, Math.max(...contributor.tasks.map(taskSortValue), 0)];
}

function normalizeProfile(row = {}) {
  return {
    accountId: safeText(row.account_id, 180),
    roleTitle: safeText(row.role_title, 220),
    roleSummary: safeText(row.role_summary, 1200),
    skills: safeArray(row.skills).map((item) => safeText(item, 160)).filter(Boolean),
    usefulTo: safeText(row.useful_to, 1200),
    updatedAt: iso(row.completed_at || row.updated_at),
  };
}

function profileLines(profile = null) {
  if (!profile?.roleTitle && !profile?.roleSummary && !profile?.skills?.length && !profile?.usefulTo) {
    return ["No completed public profile description card is available for this account."];
  }
  const lines = [];
  if (profile.roleTitle) lines.push(profile.roleTitle);
  if (profile.roleSummary) lines.push(profile.roleSummary);
  if (profile.skills?.length) lines.push(`Skills: ${profile.skills.join("; ")}`);
  if (profile.usefulTo) lines.push(`Best fit: ${profile.usefulTo}`);
  return lines;
}

function firstRowByTaskOrRequest(rows = []) {
  const byTaskId = new Map();
  const byRequestId = new Map();
  for (const row of rows) {
    const taskId = safeText(row.task_id, 180);
    const requestId = safeText(row.request_id, 180);
    if (taskId && !byTaskId.has(taskId)) byTaskId.set(taskId, row);
    if (requestId && !byRequestId.has(requestId)) byRequestId.set(requestId, row);
  }
  return { byRequestId, byTaskId };
}

function latestIdentityMaps(rows = []) {
  const publicHandleByAccount = new Map();
  const providerHandleByAccount = new Map();
  const hiveDisplayNameByAccount = new Map();
  for (const row of rows) {
    const accountId = safeText(row.account_id, 180);
    if (!accountId) continue;
    if (row.public_handle && !publicHandleByAccount.has(accountId)) {
      publicHandleByAccount.set(accountId, safeText(row.public_handle, 120));
    }
    if (row.provider_public_handle && !providerHandleByAccount.has(accountId)) {
      providerHandleByAccount.set(accountId, safeText(row.provider_public_handle, 120));
    }
    if (row.hive_display_name && !hiveDisplayNameByAccount.has(accountId)) {
      hiveDisplayNameByAccount.set(accountId, safeText(row.hive_display_name, 180));
    }
  }
  return { hiveDisplayNameByAccount, providerHandleByAccount, publicHandleByAccount };
}

function buildContributorPackets({ badgesByAccount = new Map(), profilesByAccount = new Map(), taskRows = [] } = {}) {
  const contributorsByKey = new Map();
  for (const row of taskRows) {
    const task = normalizeTaskRow(row);
    if (!task.accountId && !task.walletAddress) continue;
    const key = task.accountId ? `account:${task.accountId}` : `wallet:${task.walletAddress.toLowerCase()}`;
    if (!contributorsByKey.has(key)) {
      contributorsByKey.set(key, {
        key,
        accountId: task.accountId,
        walletAddress: task.walletAddress,
        handle: task.handle,
        displayName: task.displayName,
        tasks: [],
        proposals: [],
        outstanding: [],
        rewarded: [],
      });
    }
    const contributor = contributorsByKey.get(key);
    contributor.accountId ||= task.accountId;
    contributor.walletAddress ||= task.walletAddress;
    contributor.handle ||= task.handle;
    contributor.displayName ||= task.displayName;
    contributor.tasks.push(task);
    if (proposalStatuses.has(task.normalizedStatus)) contributor.proposals.push(task);
    if (outstandingStatuses.has(task.normalizedStatus)) contributor.outstanding.push(task);
    if (rewardedStatuses.has(task.normalizedStatus)) contributor.rewarded.push(task);
  }

  const contributors = Array.from(contributorsByKey.values()).map((contributor) => {
    const sortTasks = (items = []) => [...items].sort((left, right) => taskSortValue(right) - taskSortValue(left));
    const accountId = contributor.accountId;
    return {
      ...contributor,
      tasks: sortTasks(contributor.tasks),
      proposals: sortTasks(contributor.proposals).slice(0, 5),
      outstanding: sortTasks(contributor.outstanding).slice(0, 5),
      rewarded: sortTasks(contributor.rewarded).slice(0, 5),
      profile: accountId ? profilesByAccount.get(accountId) || null : null,
      badges: accountId ? badgesByAccount.get(accountId) || [] : [],
    };
  });

  return contributors.sort((left, right) => {
    const [leftLive, leftRecent] = contributorSortValue(left);
    const [rightLive, rightRecent] = contributorSortValue(right);
    return rightLive - leftLive || rightRecent - leftRecent || contributorLabel(left).localeCompare(contributorLabel(right));
  });
}

function buildPacketText({ contributors = [], generatedAt = new Date().toISOString(), limit = 24 } = {}) {
  const lines = [
    "Live Task Packet",
    `Generated: ${generatedAt}`,
    "Refresh cadence: 30 seconds.",
    "Assembly: deterministic database read from Network task projections, project task refs, profile description snapshots, and verified badges. No LLM was used.",
    `Contributor count shown: ${contributors.length}${contributors.length >= limit ? ` (limited to ${limit})` : ""}`,
    "",
  ];

  if (!contributors.length) {
    lines.push("No assigned or recently rewarded Network Task contributors are available in the live packet source rows.");
    return lines.join("\n");
  }

  contributors.forEach((contributor, index) => {
    lines.push(`Contributor ${index + 1}: ${contributorLabel(contributor)}`);
    lines.push(`Account: ${contributor.accountId || "No linked account in task rows."}`);
    lines.push(`Wallet: ${contributor.walletAddress || "No wallet in task rows."}`);
    lines.push("");
    lines.push("Network Task Assigned Proposal");
    lines.push(...lineList(contributor.proposals.map(taskLine)));
    lines.push("");
    lines.push("Network Task Outstanding");
    lines.push(...lineList(contributor.outstanding.map(taskLine)));
    lines.push("");
    lines.push("Last 5 Rewarded Network Tasks");
    lines.push(...lineList(contributor.rewarded.map(taskLine)));
    lines.push("");
    lines.push("Contributor description card");
    for (const line of profileLines(contributor.profile)) {
      lines.push(line);
    }
    lines.push("");
    lines.push(`Contributor Badges: ${contributor.badges.length ? contributor.badges.join(", ") : "No verified contributor badges found for this account."}`);
    if (index < contributors.length - 1) lines.push("", "");
  });

  return lines.join("\n");
}

async function listProjectionPacketRows() {
  const result = await query(
    `
      SELECT projection.task_id,
             projection.account_id,
             projection.subject_wallet,
             projection.request_id,
             projection.status,
             projection.title,
             projection.description,
             projection.reward_offer_pft,
             projection.reward_actual_pft,
             projection.last_event_at,
             projection.updated_at,
             projection.created_at
      FROM task_projections projection
      WHERE projection.task_kind = 'network'
        AND projection.status = ANY($1::text[])
      ORDER BY
        CASE
          WHEN projection.status IN ('accepted', 'submitted', 'verification_requested', 'verification_response_submitted') THEN 0
          WHEN projection.status = 'proposed' THEN 1
          ELSE 2
        END,
        projection.updated_at DESC NULLS LAST,
        projection.last_event_at DESC NULLS LAST,
        projection.task_id DESC
      LIMIT 600
    `,
    [packetStatuses]
  );
  return result.rows || [];
}

async function listProjectRefsForTasks({ requestIds = [], taskIds = [] } = {}) {
  const safeTaskIds = [...new Set(taskIds.map((item) => safeText(item, 180)).filter(Boolean))].slice(0, 600);
  const safeRequestIds = [...new Set(requestIds.map((item) => safeText(item, 180)).filter(Boolean))].slice(0, 600);
  if (!safeTaskIds.length && !safeRequestIds.length) return [];
  const [taskResult, requestResult] = await Promise.all([
    safeTaskIds.length
      ? query(
          `
            SELECT ref.task_id,
                   ref.request_id,
                   ref.project_id,
                   ref.assignee_wallet,
                   ref.updated_at,
                   contributor.codename,
                   project.title AS project_title
            FROM network_project_task_refs ref
            LEFT JOIN network_projects project
              ON project.id = ref.project_id
            LEFT JOIN network_project_contributors contributor
              ON contributor.project_id = ref.project_id
             AND contributor.wallet_address = ref.assignee_wallet
            WHERE ref.task_id = ANY($1::text[])
            ORDER BY ref.updated_at DESC NULLS LAST, ref.id DESC
          `,
          [safeTaskIds]
        )
      : Promise.resolve({ rows: [] }),
    safeRequestIds.length
      ? query(
          `
            SELECT ref.task_id,
                   ref.request_id,
                   ref.project_id,
                   ref.assignee_wallet,
                   ref.updated_at,
                   contributor.codename,
                   project.title AS project_title
            FROM network_project_task_refs ref
            LEFT JOIN network_projects project
              ON project.id = ref.project_id
            LEFT JOIN network_project_contributors contributor
              ON contributor.project_id = ref.project_id
             AND contributor.wallet_address = ref.assignee_wallet
            WHERE ref.request_id = ANY($1::text[])
            ORDER BY ref.updated_at DESC NULLS LAST, ref.id DESC
          `,
          [safeRequestIds]
        )
      : Promise.resolve({ rows: [] }),
  ]);
  return [...(taskResult.rows || []), ...(requestResult.rows || [])];
}

async function listIdentityRowsByAccount(accountIds = []) {
  const safeAccountIds = [...new Set(accountIds.map((item) => safeText(item, 180)).filter(Boolean))].slice(0, 600);
  if (!safeAccountIds.length) return [];
  const [approvalResult, hiveResult] = await Promise.all([
    query(
      `
        SELECT DISTINCT ON (account_id)
               account_id,
               public_handle AS provider_public_handle
        FROM account_identity_approvals
        WHERE account_id = ANY($1::text[])
          AND status = 'active'
          AND public_handle <> ''
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY account_id, updated_at DESC, id DESC
      `,
      [safeAccountIds]
    ).catch(() => ({ rows: [] })),
    query(
      `
        SELECT DISTINCT ON (account_id)
               account_id,
               display_name AS hive_display_name
        FROM hive_context_entries
        WHERE account_id = ANY($1::text[])
          AND deleted_at IS NULL
          AND display_name <> ''
        ORDER BY account_id, created_at DESC, id DESC
      `,
      [safeAccountIds]
    ).catch(() => ({ rows: [] })),
  ]);
  return [
    ...(approvalResult.rows || []),
    ...(hiveResult.rows || []),
  ];
}

async function listPacketTaskRows() {
  const projectionRows = await listProjectionPacketRows();
  const refLookup = firstRowByTaskOrRequest(await listProjectRefsForTasks({
    requestIds: projectionRows.map((row) => row.request_id),
    taskIds: projectionRows.map((row) => row.task_id),
  }));
  const accountIds = projectionRows.map((row) => row.account_id);
  const identities = latestIdentityMaps(await listIdentityRowsByAccount(accountIds));
  const rows = [];

  for (const row of projectionRows) {
    const ref = refLookup.byTaskId.get(safeText(row.task_id, 180)) ||
      refLookup.byRequestId.get(safeText(row.request_id, 180)) ||
      {};
    const accountId = safeText(row.account_id, 180);
    rows.push({
      ...row,
      resolved_account_id: accountId,
      wallet_address: safeText(row.subject_wallet || ref.assignee_wallet, 140),
      project_id: safeText(ref.project_id, 160),
      assignee_wallet: safeText(ref.assignee_wallet, 140),
      codename: safeText(ref.codename, 180),
      project_title: safeText(ref.project_title, 260),
      public_handle: identities.publicHandleByAccount.get(accountId) || "",
      provider_public_handle: identities.providerHandleByAccount.get(accountId) || "",
      hive_display_name: identities.hiveDisplayNameByAccount.get(accountId) || "",
    });
  }
  return rows;
}

async function listProfilesByAccount(accountIds = []) {
  if (!accountIds.length) return new Map();
  const result = await query(
    `
      SELECT DISTINCT ON (account_id)
             account_id,
             role_title,
             role_summary,
             skills,
             useful_to,
             completed_at,
             updated_at
      FROM profile_public_snapshots
      WHERE status = 'completed'
        AND account_id = ANY($1::text[])
      ORDER BY account_id, completed_at DESC NULLS LAST, updated_at DESC
    `,
    [accountIds]
  ).catch(() => ({ rows: [] }));
  return new Map((result.rows || []).map((row) => [safeText(row.account_id, 180), normalizeProfile(row)]));
}

async function listBadgesByAccount(accountIds = []) {
  if (!accountIds.length) return new Map();
  const result = await query(
    `
      SELECT badge.account_id,
             definition.label
      FROM account_network_badges badge
      JOIN network_badge_definitions definition
        ON definition.badge_id = badge.badge_id
      WHERE badge.account_id = ANY($1::text[])
        AND badge.status = 'verified'
        AND badge.revoked_at IS NULL
        AND definition.active = true
        AND (badge.expires_at IS NULL OR badge.expires_at > now())
      ORDER BY badge.account_id ASC, badge.selected_default DESC, definition.label ASC
    `,
    [accountIds]
  ).catch(() => ({ rows: [] }));
  const map = new Map();
  for (const row of result.rows || []) {
    const accountId = safeText(row.account_id, 180);
    if (!accountId) continue;
    if (!map.has(accountId)) map.set(accountId, []);
    map.get(accountId).push(safeText(row.label || "Badge", 120));
  }
  return map;
}

export function formatHiveLiveTaskPacket({ contributors = [], generatedAt = new Date().toISOString(), limit = 24 } = {}) {
  return buildPacketText({ contributors, generatedAt, limit });
}

export async function getHiveLiveTaskPacket({ limit = 24 } = {}) {
  if (!databaseEnabled()) {
    return {
      ok: false,
      status: 503,
      error: "database_not_enabled",
      message: "Live Task Packet requires the Postgres read model.",
    };
  }
  const safeLimit = intValue(limit, 24, { min: 1, max: 80 });
  const generatedAt = new Date().toISOString();
  const taskRows = await listPacketTaskRows();
  const accountIds = Array.from(new Set(taskRows.map((row) => safeText(row.resolved_account_id || row.account_id, 180)).filter(Boolean)));
  const [profilesByAccount, badgesByAccount] = await Promise.all([
    listProfilesByAccount(accountIds),
    listBadgesByAccount(accountIds),
  ]);
  const contributors = buildContributorPackets({ badgesByAccount, profilesByAccount, taskRows }).slice(0, safeLimit);
  const text = buildPacketText({ contributors, generatedAt, limit: safeLimit });
  return {
    ok: true,
    packet: {
      generatedAt,
      refreshCadenceSeconds: 30,
      source: "deterministic_database_assembly",
      contributorCount: contributors.length,
      text,
      contributors,
    },
  };
}
