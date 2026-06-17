import { randomUUID } from "node:crypto";
import { databaseEnabled, isUniqueViolation, query } from "../db/pool.js";
import { getAccountWalletCloud } from "../account-wallet-cloud.js";
import { getAccountIdentityProfile } from "../runtime-store.js";
import { listMachineOperatorDisclosures } from "./capability-profiles.js";
import { countProfileNfts, getPublicProfileHeroNft, listProfileNfts } from "./profile-nfts.js";

const runtimeSnapshots = new Map();

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toNumber(value = 0) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundPft(value = 0) {
  return Number(toNumber(value).toFixed(6));
}

function objectFromValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  const raw = value.trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function arrayFromValue(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function uniqueWalletAddresses(values = []) {
  return Array.from(new Set(values.map((value) => safeText(value, 160)).filter(Boolean)));
}

function normalizeSnapshot(row = null) {
  if (!row) return null;
  const skills = arrayFromValue(row.skills || row.output_json?.skills || row.outputJson?.skills);
  return {
    snapshotId: row.snapshot_id || row.snapshotId || "",
    accountId: row.account_id || row.accountId || "",
    status: row.status || "",
    inputFingerprint: row.input_fingerprint || row.inputFingerprint || "",
    inputSnapshot: row.input_snapshot || row.inputSnapshot || {},
    output: row.output_json || row.outputJson || {},
    roleTitle: safeText(row.role_title || row.roleTitle, 120),
    roleSummary: safeText(row.role_summary || row.roleSummary, 1000),
    skills: skills.map((skill) => safeText(typeof skill === "string" ? skill : skill?.name, 80)).filter(Boolean),
    archetype: safeText(row.archetype || "", 80),
    archetypeContrast: safeText(row.archetype_contrast || row.archetypeContrast, 180),
    usefulTo: safeText(row.useful_to || row.usefulTo, 400),
    dataCaveat: safeText(row.data_caveat || row.dataCaveat, 400),
    provider: safeText(row.provider, 80),
    model: safeText(row.model, 160),
    promptVersion: safeText(row.prompt_version || row.promptVersion, 120),
    promptDigest: safeText(row.prompt_digest || row.promptDigest, 160),
    outputDigest: safeText(row.output_digest || row.outputDigest, 160),
    errorMessage: safeText(row.error_message || row.errorMessage, 1200),
    startedAt: toIso(row.started_at || row.startedAt),
    completedAt: toIso(row.completed_at || row.completedAt),
    createdAt: toIso(row.created_at || row.createdAt),
    updatedAt: toIso(row.updated_at || row.updatedAt),
  };
}

function contributionTier({ trailingRewardedTasks = 0, trailingTaskRewardPft = 0 } = {}) {
  const tasks = Math.max(0, Number(trailingRewardedTasks || 0));
  const pft = Math.max(0, Number(trailingTaskRewardPft || 0));
  let tier = 0;
  if (tasks >= 25 || pft >= 100) tier = 4;
  else if (tasks >= 12 || pft >= 35) tier = 3;
  else if (tasks >= 5 || pft >= 10) tier = 2;
  else if (tasks >= 1 || pft >= 1) tier = 1;
  return {
    tier: `T${tier}`,
    maxTier: "T4",
    tierNumber: tier,
    maxTierNumber: 4,
    basis: tier === 0
      ? "No positive task rewards in the trailing 30 days"
      : `${tasks} rewarded task${tasks === 1 ? "" : "s"} and ${roundPft(pft)} task-reward PFT in the trailing 30 days`,
  };
}

function sortPublicNfts(nfts = []) {
  return publicVisibleNfts(nfts)
    .sort((left, right) => {
      if (Boolean(left.selected) !== Boolean(right.selected)) return left.selected ? -1 : 1;
      const leftCreated = String(left.createdAt || left.generatedAt || left.mintedAt || "");
      const rightCreated = String(right.createdAt || right.generatedAt || right.mintedAt || "");
      if (leftCreated !== rightCreated) return rightCreated.localeCompare(leftCreated);
      return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
    });
}

function latestNftImage(nfts = []) {
  return sortPublicNfts(nfts)[0] || null;
}

function publicVisibleNfts(nfts = []) {
  return (Array.isArray(nfts) ? nfts : []).filter((nft) =>
    ["minted", "generated", "prepared"].includes(String(nft.status || "").toLowerCase())
  );
}

async function queryWalletStats({ accountId }) {
  if (!databaseEnabled()) return [];
  const result = await query(
    `SELECT subject_wallet AS wallet_address,
            COUNT(task_id)::integer AS task_count,
            COUNT(task_id) FILTER (WHERE reward_actual_pft > 0)::integer AS rewarded_task_count,
            COALESCE(SUM(reward_actual_pft), 0)::text AS reward_pft,
            MAX(updated_at) AS last_task_at
       FROM task_projections
      WHERE account_id = $1
        AND subject_wallet <> ''
      GROUP BY subject_wallet
      ORDER BY task_count DESC, rewarded_task_count DESC, reward_pft DESC, last_task_at DESC NULLS LAST`,
    [safeText(accountId, 180)]
  );
  return result.rows.map((row) => ({
    walletAddress: safeText(row.wallet_address, 160),
    taskCount: toNumber(row.task_count),
    rewardedTaskCount: toNumber(row.rewarded_task_count),
    rewardPft: roundPft(row.reward_pft),
    lastTaskAt: toIso(row.last_task_at),
  }));
}

async function queryRewardTotals({ accountId }) {
  if (!databaseEnabled()) {
    return {
      lifetimeTaskRewardPft: 0,
      lifetimeAirdropPft: 0,
      lifetimeTotalPft: 0,
      lifetimeRewardedTasks: 0,
      trailing30dRewardedTasks: 0,
      trailing30dTaskRewardPft: 0,
    };
  }
  const result = await query(
    `WITH reward_events AS (
       SELECT DISTINCT ON (task_id)
              task_id,
              occurred_at
         FROM task_events
        WHERE account_id = $1
          AND event_type = 'pf.reward.v1'
        ORDER BY task_id, occurred_at DESC
     ),
     task_rewards AS (
       SELECT p.task_id,
              p.reward_actual_pft,
              COALESCE(r.occurred_at, p.last_event_at, p.updated_at) AS rewarded_at
         FROM task_projections p
         LEFT JOIN reward_events r ON r.task_id = p.task_id
        WHERE p.account_id = $1
          AND p.reward_actual_pft > 0
     ),
     task_totals AS (
       SELECT COALESCE(SUM(reward_actual_pft), 0)::text AS lifetime_task_reward_pft,
              COUNT(task_id)::integer AS lifetime_rewarded_tasks,
              COALESCE(SUM(reward_actual_pft) FILTER (WHERE rewarded_at >= now() - interval '30 days'), 0)::text AS trailing_30d_task_reward_pft,
              COUNT(task_id) FILTER (WHERE rewarded_at >= now() - interval '30 days')::integer AS trailing_30d_rewarded_tasks
         FROM task_rewards
     ),
     airdrop_totals AS (
       SELECT COALESCE(SUM(amount_pft), 0)::text AS lifetime_airdrop_pft
         FROM profile_daily_airdrop_issuances
        WHERE account_id = $1
          AND status = 'submitted'
     )
     SELECT task_totals.*,
            airdrop_totals.lifetime_airdrop_pft
       FROM task_totals, airdrop_totals`,
    [safeText(accountId, 180)]
  );
  const row = result.rows[0] || {};
  const taskPft = roundPft(row.lifetime_task_reward_pft);
  const airdropPft = roundPft(row.lifetime_airdrop_pft);
  return {
    lifetimeTaskRewardPft: taskPft,
    lifetimeAirdropPft: airdropPft,
    lifetimeTotalPft: roundPft(taskPft + airdropPft),
    lifetimeRewardedTasks: toNumber(row.lifetime_rewarded_tasks),
    trailing30dRewardedTasks: toNumber(row.trailing_30d_rewarded_tasks),
    trailing30dTaskRewardPft: roundPft(row.trailing_30d_task_reward_pft),
  };
}

async function queryLatestAlignment({ accountId }) {
  if (!databaseEnabled()) return null;
  const result = await query(
    `SELECT alignment_score_7d::text AS alignment_score_7d,
            actual_airdrop_pft_7d::text AS actual_airdrop_pft_7d,
            max_possible_airdrop_pft_7d::text AS max_possible_airdrop_pft_7d,
            completed_at,
            run_date
       FROM profile_daily_airdrop_runs
      WHERE account_id = $1
        AND status = 'completed'
      ORDER BY completed_at DESC NULLS LAST, updated_at DESC, created_at DESC
      LIMIT 1`,
    [safeText(accountId, 180)]
  );
  const row = result.rows[0] || null;
  if (!row) return null;
  const score = Math.max(0, Math.min(100, Math.round(toNumber(row.alignment_score_7d) * 100)));
  return {
    score0To100: score,
    source: "profile_daily_airdrop_runs.alignment_score_7d",
    actualAirdropPft7d: roundPft(row.actual_airdrop_pft_7d),
    maxPossibleAirdropPft7d: roundPft(row.max_possible_airdrop_pft_7d),
    completedAt: toIso(row.completed_at),
    runDate: row.run_date ? String(row.run_date).slice(0, 10) : "",
  };
}

async function queryRecentRewardedTasks({ accountId, limit = 12 } = {}) {
  if (!databaseEnabled()) return [];
  const result = await query(
    `WITH reward_events AS (
       SELECT DISTINCT ON (task_id)
              task_id,
              source_tx_hash,
              source_cid,
              occurred_at,
              payload_json
         FROM task_events
        WHERE account_id = $1
          AND event_type = 'pf.reward.v1'
        ORDER BY task_id, occurred_at DESC
     )
     SELECT p.task_id,
            p.title,
            p.description,
            p.task_kind,
            p.reward_offer_pft::text AS reward_offer_pft,
            p.reward_actual_pft::text AS reward_paid_pft,
            p.submission_requirement_text,
            p.updated_at,
            p.last_event_at,
            r.occurred_at AS rewarded_at,
            r.payload_json AS reward_payload
       FROM task_projections p
       LEFT JOIN reward_events r ON r.task_id = p.task_id
      WHERE p.account_id = $1
        AND p.reward_actual_pft > 0
      ORDER BY COALESCE(r.occurred_at, p.last_event_at, p.updated_at) DESC, p.task_id ASC
      LIMIT $2`,
    [safeText(accountId, 180), Math.min(Math.max(Number(limit || 12), 1), 30)]
  );
  return result.rows.map((row) => {
    const rewardPayload = objectFromValue(row.reward_payload);
    const score = objectFromValue(rewardPayload.reward_score || rewardPayload.score);
    return {
      task_proposal: {
        title: safeText(row.title, 240),
        description: safeText(row.description, 1200),
        kind: safeText(row.task_kind, 80),
        reward_offer_pft: roundPft(row.reward_offer_pft),
        submission_requirement: safeText(row.submission_requirement_text, 900),
      },
      reward_text: {
        reward_paid_pft: roundPft(row.reward_paid_pft),
        decision: safeText(score.decision || rewardPayload.reward_decision || "", 80),
        text: safeText(score.user_feedback || rewardPayload.user_feedback || "", 900),
      },
    };
  });
}

function primaryWallet({ walletCloud, walletStats, nfts }) {
  const active = safeText(walletCloud.activeWalletAddress, 160);
  if (active) return active;
  const ranked = [...walletStats].sort((left, right) => {
    if (right.taskCount !== left.taskCount) return right.taskCount - left.taskCount;
    if (right.rewardedTaskCount !== left.rewardedTaskCount) return right.rewardedTaskCount - left.rewardedTaskCount;
    if (right.rewardPft !== left.rewardPft) return right.rewardPft - left.rewardPft;
    return String(right.lastTaskAt || "").localeCompare(String(left.lastTaskAt || ""));
  });
  if (ranked[0]?.walletAddress) return ranked[0].walletAddress;
  return safeText(nfts.find((nft) => nft.walletAddress)?.walletAddress, 160);
}

export async function buildPublicProfileSnapshotInput({ accountId } = {}) {
  const normalizedAccount = safeText(accountId, 180);
  if (!normalizedAccount) throw new Error("profile_public_account_required");
  const walletCloud = getAccountWalletCloud({ accountId: normalizedAccount });
  const [walletStats, rewardTotals, alignment, recentRewardedTasks, nfts] = await Promise.all([
    queryWalletStats({ accountId: normalizedAccount }),
    queryRewardTotals({ accountId: normalizedAccount }),
    queryLatestAlignment({ accountId: normalizedAccount }),
    queryRecentRewardedTasks({ accountId: normalizedAccount, limit: 24 }),
    listProfileNfts({
      accountId: normalizedAccount,
      limit: 240,
      publicOnly: true,
    }),
  ]);
  const cloudWallets = walletCloud.wallets.map((wallet) => ({
    walletAddress: wallet.address,
    status: wallet.status,
    sources: wallet.sources || [],
    linkedAt: wallet.linkedAt || null,
    updatedAt: wallet.updatedAt || null,
  }));
  const walletsByAddress = new Map();
  for (const wallet of cloudWallets) {
    walletsByAddress.set(wallet.walletAddress, {
      ...wallet,
      taskCount: 0,
      rewardedTaskCount: 0,
      rewardPft: 0,
      lastTaskAt: null,
      active: wallet.walletAddress === walletCloud.activeWalletAddress,
    });
  }
  for (const stat of walletStats) {
    walletsByAddress.set(stat.walletAddress, {
      ...(walletsByAddress.get(stat.walletAddress) || {
        walletAddress: stat.walletAddress,
        status: "task_history",
        sources: ["task_projections"],
        active: stat.walletAddress === walletCloud.activeWalletAddress,
      }),
      taskCount: stat.taskCount,
      rewardedTaskCount: stat.rewardedTaskCount,
      rewardPft: stat.rewardPft,
      lastTaskAt: stat.lastTaskAt,
    });
  }
  const visibleNfts = publicVisibleNfts(nfts);
  for (const nft of visibleNfts) {
    if (!nft.walletAddress || walletsByAddress.has(nft.walletAddress)) continue;
    walletsByAddress.set(nft.walletAddress, {
      walletAddress: nft.walletAddress,
      status: "profile_nft",
      sources: ["profile_nfts"],
      active: nft.walletAddress === walletCloud.activeWalletAddress,
      taskCount: 0,
      rewardedTaskCount: 0,
      rewardPft: 0,
      lastTaskAt: null,
    });
  }
  const wallets = Array.from(walletsByAddress.values()).sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    if (right.taskCount !== left.taskCount) return right.taskCount - left.taskCount;
    if (right.rewardedTaskCount !== left.rewardedTaskCount) return right.rewardedTaskCount - left.rewardedTaskCount;
    return String(right.lastTaskAt || "").localeCompare(String(left.lastTaskAt || ""));
  });
  const tier = contributionTier({
    trailingRewardedTasks: rewardTotals.trailing30dRewardedTasks,
    trailingTaskRewardPft: rewardTotals.trailing30dTaskRewardPft,
  });
  const primary = primaryWallet({ walletCloud, walletStats, nfts: visibleNfts });
  return {
    schema: "pf.profile.public_snapshot_input.v1",
    account_id: normalizedAccount,
    computed_at: new Date().toISOString(),
    identity: {
      account_id: normalizedAccount,
      primary_wallet: primary,
      active_wallet: walletCloud.activeWalletAddress || "",
      wallet_count: wallets.length,
      wallets,
    },
    reward_totals: rewardTotals,
    alignment: alignment || {
      score0To100: null,
      source: "",
      actualAirdropPft7d: 0,
      maxPossibleAirdropPft7d: 0,
      completedAt: null,
      runDate: "",
    },
    contribution_tier: tier,
    recent_rewarded_tasks: recentRewardedTasks,
    nfts: visibleNfts.map((nft) => ({
      id: nft.id,
      title: nft.title,
      status: nft.status,
      imageCid: nft.imageCid,
      metadataCid: nft.metadataCid,
      txHash: nft.txHash,
      nftTokenId: nft.nftTokenId,
      generatedAt: nft.generatedAt,
      mintedAt: nft.mintedAt,
      selected: nft.selected,
    })),
  };
}

export function publicProfileFromParts({
  accountId = "",
  input = null,
  heroNft = null,
  snapshot = null,
  nfts = [],
  nftTotal = null,
  operatorDisclosure = null,
} = {}) {
  const packet = input || {};
  const metrics = packet.reward_totals || {};
  const alignment = packet.alignment || {};
  const tier = packet.contribution_tier || contributionTier();
  const nftRows = sortPublicNfts(nfts.length ? nfts : []);
  const heroNftRows = publicVisibleNfts(heroNft ? [heroNft] : []);
  const profileHeroNft = heroNftRows[0] || latestNftImage(nftRows);
  const profileNftRows = profileHeroNft && !nftRows.some((nft) =>
    (profileHeroNft.id && nft.id === profileHeroNft.id) ||
    (profileHeroNft.imageCid && nft.imageCid === profileHeroNft.imageCid)
  )
    ? [profileHeroNft, ...nftRows.slice(0, 239)]
    : nftRows;
  const identityAccountId = safeText(accountId || packet.account_id, 180);
  const identityProfile = getAccountIdentityProfile({ accountId: identityAccountId }) || {};
  const publicAliases = Array.isArray(identityProfile.publicAliases)
    ? identityProfile.publicAliases
    : Array.isArray(packet.identity?.public_aliases)
      ? packet.identity.public_aliases
      : [];
  const publicTrustBadges = Array.isArray(identityProfile.publicTrustBadges)
    ? identityProfile.publicTrustBadges
    : Array.isArray(packet.identity?.public_trust_badges)
      ? packet.identity.public_trust_badges
      : [];
  return {
    identity: {
      accountId: identityAccountId,
      hiveHandle: safeText(identityProfile.hiveHandle || packet.identity?.hive_handle, 80),
      displayName: safeText(identityProfile.displayName || packet.identity?.display_name, 120),
      publicAliases: publicAliases.map((alias) => ({
        provider: safeText(alias.provider, 40),
        label: safeText(alias.label, 80),
        handle: safeText(alias.handle, 120),
        profileUrl: safeText(alias.profileUrl, 400),
        verified: alias.verified === true,
        linkedAt: safeText(alias.linkedAt, 80),
      })),
      publicTrustBadges: publicTrustBadges.map((badge) => ({
        provider: safeText(badge.provider, 40),
        label: safeText(badge.label, 80),
      })),
      primaryWallet: safeText(packet.identity?.primary_wallet, 160),
      activeWallet: safeText(packet.identity?.active_wallet, 160),
      displayWallet: safeText(packet.identity?.primary_wallet || packet.identity?.active_wallet, 160),
      walletCount: toNumber(packet.identity?.wallet_count),
      operatorDisclosure,
    },
    metrics: {
      lifetimeTaskRewardPft: roundPft(metrics.lifetimeTaskRewardPft),
      lifetimeAirdropPft: roundPft(metrics.lifetimeAirdropPft),
      lifetimeTotalPft: roundPft(metrics.lifetimeTotalPft),
      lifetimeRewardedTasks: toNumber(metrics.lifetimeRewardedTasks),
      trailing30dRewardedTasks: toNumber(metrics.trailing30dRewardedTasks),
      trailing30dTaskRewardPft: roundPft(metrics.trailing30dTaskRewardPft),
      alignmentScore0To100: alignment.score0To100 === null || alignment.score0To100 === undefined ? null : toNumber(alignment.score0To100),
      alignmentSource: safeText(alignment.source, 160),
      actualAirdropPft7d: roundPft(alignment.actualAirdropPft7d),
      maxPossibleAirdropPft7d: roundPft(alignment.maxPossibleAirdropPft7d),
      contributionTier: safeText(tier.tier, 20),
      contributionTierMax: safeText(tier.maxTier, 20),
      contributionTierNumber: toNumber(tier.tierNumber),
      contributionTierMaxNumber: toNumber(tier.maxTierNumber || 4),
      contributionTierBasis: safeText(tier.basis, 240),
    },
    role: snapshot?.status === "completed" ? {
      roleTitle: snapshot.roleTitle,
      roleSummary: snapshot.roleSummary,
      skills: snapshot.skills,
      archetype: snapshot.archetype,
      archetypeContrast: snapshot.archetypeContrast,
      usefulTo: snapshot.usefulTo,
      dataCaveat: snapshot.dataCaveat,
    } : null,
    nfts: profileNftRows,
    nftTotal: Number.isFinite(Number(nftTotal)) ? Number(nftTotal) : profileNftRows.length,
    heroNft: profileHeroNft,
    snapshot: snapshot ? {
      snapshotId: snapshot.snapshotId,
      status: snapshot.status,
      completedAt: snapshot.completedAt,
      provider: snapshot.provider,
      model: snapshot.model,
      promptVersion: snapshot.promptVersion,
      promptDigest: snapshot.promptDigest,
      inputFingerprint: snapshot.inputFingerprint,
      errorMessage: snapshot.errorMessage,
    } : null,
  };
}

export async function getLatestPublicProfileSnapshot({ accountId } = {}) {
  const normalizedAccount = safeText(accountId, 180);
  if (!normalizedAccount) return null;
  if (!databaseEnabled()) {
    const rows = Array.from(runtimeSnapshots.values())
      .filter((row) => row.account_id === normalizedAccount && row.status === "completed")
      .sort((left, right) => String(right.completed_at || right.updated_at || "").localeCompare(String(left.completed_at || left.updated_at || "")));
    return normalizeSnapshot(rows[0] || null);
  }
  const result = await query(
    `SELECT *
       FROM profile_public_snapshots
      WHERE account_id = $1
        AND status = 'completed'
      ORDER BY completed_at DESC NULLS LAST, updated_at DESC, created_at DESC
      LIMIT 1`,
    [normalizedAccount]
  );
  return normalizeSnapshot(result.rows[0] || null);
}

export async function getCompletedPublicProfileSnapshotByFingerprint({
  accountId = "",
  inputFingerprint = "",
  model = "",
  promptDigest = "",
} = {}) {
  const normalizedAccount = safeText(accountId, 180);
  const fingerprint = safeText(inputFingerprint, 160);
  const normalizedModel = safeText(model, 160);
  const normalizedPromptDigest = safeText(promptDigest, 160);
  if (!normalizedAccount || !fingerprint) return null;
  if (!databaseEnabled()) {
    const row = Array.from(runtimeSnapshots.values()).find((snapshot) =>
      snapshot.account_id === normalizedAccount &&
      snapshot.input_fingerprint === fingerprint &&
      (!normalizedModel || snapshot.model === normalizedModel) &&
      (!normalizedPromptDigest || snapshot.prompt_digest === normalizedPromptDigest) &&
      snapshot.status === "completed"
    );
    return normalizeSnapshot(row || null);
  }
  const result = await query(
    `SELECT *
      FROM profile_public_snapshots
      WHERE account_id = $1
        AND input_fingerprint = $2
        AND ($3 = '' OR prompt_digest = $3)
        AND ($4 = '' OR model = $4)
        AND status = 'completed'
      ORDER BY completed_at DESC NULLS LAST, updated_at DESC
      LIMIT 1`,
    [normalizedAccount, fingerprint, normalizedPromptDigest, normalizedModel]
  );
  return normalizeSnapshot(result.rows[0] || null);
}

export async function getPublicProfile({ accountId } = {}) {
  const normalizedAccount = safeText(accountId, 180);
  if (!normalizedAccount) throw new Error("profile_public_account_required");
  const [input, snapshot, nfts, nftTotal, heroNft] = await Promise.all([
    buildPublicProfileSnapshotInput({ accountId: normalizedAccount }),
    getLatestPublicProfileSnapshot({ accountId: normalizedAccount }),
    listProfileNfts({
      accountId: normalizedAccount,
      limit: 240,
      publicOnly: true,
    }),
    countProfileNfts({ accountId: normalizedAccount, publicOnly: true }),
    getPublicProfileHeroNft({ accountId: normalizedAccount }),
  ]);
  const operatorDisclosures = await listMachineOperatorDisclosures({ accountIds: [normalizedAccount] }).catch(() => ({}));
  return publicProfileFromParts({
    accountId: normalizedAccount,
    input,
    heroNft,
    nftTotal,
    snapshot,
    nfts,
    operatorDisclosure: operatorDisclosures[normalizedAccount] || null,
  });
}

export async function createPublicProfileSnapshotRun({
  accountId,
  inputFingerprint = "",
  inputSnapshot = {},
  provider = "",
  model = "",
  promptVersion = "",
  promptDigest = "",
} = {}) {
  const normalizedAccount = safeText(accountId, 180);
  if (!normalizedAccount) throw new Error("profile_public_account_required");
  const snapshotId = `profile_public_${randomUUID()}`;
  const now = new Date().toISOString();

  if (!databaseEnabled()) {
    const row = {
      snapshot_id: snapshotId,
      account_id: normalizedAccount,
      status: "running",
      input_fingerprint: inputFingerprint,
      input_snapshot: inputSnapshot,
      provider,
      model,
      prompt_version: promptVersion,
      prompt_digest: promptDigest,
      started_at: now,
      created_at: now,
      updated_at: now,
    };
    runtimeSnapshots.set(snapshotId, row);
    return normalizeSnapshot(row);
  }

  const result = await query(
    `INSERT INTO profile_public_snapshots (
       snapshot_id, account_id, status, input_fingerprint, input_snapshot,
       provider, model, prompt_version, prompt_digest, started_at
     )
     VALUES ($1, $2, 'running', $3, $4::jsonb, $5, $6, $7, $8, now())
     RETURNING *`,
    [
      snapshotId,
      normalizedAccount,
      safeText(inputFingerprint, 160),
      JSON.stringify(inputSnapshot || {}),
      safeText(provider, 80),
      safeText(model, 160),
      safeText(promptVersion, 120),
      safeText(promptDigest, 160),
    ]
  );
  return normalizeSnapshot(result.rows[0] || null);
}

export async function completePublicProfileSnapshot({
  snapshotId,
  output = {},
  outputDigest = "",
} = {}) {
  const roleTitle = safeText(output.role_title || output.roleTitle, 120);
  const roleSummary = safeText(output.role_summary || output.roleSummary, 1000);
  const skills = arrayFromValue(output.skills).map((skill) => safeText(typeof skill === "string" ? skill : skill?.name, 80)).filter(Boolean).slice(0, 7);
  const archetype = safeText(output.archetype, 80);
  const archetypeContrast = safeText(output.archetype_contrast || output.archetypeContrast, 180);
  const usefulTo = safeText(output.useful_to || output.usefulTo, 400);
  const dataCaveat = safeText(output.data_caveat || output.dataCaveat, 400);
  const normalizedId = safeText(snapshotId, 160);

  if (!databaseEnabled()) {
    const row = runtimeSnapshots.get(normalizedId);
    if (!row) return null;
    const next = {
      ...row,
      status: "completed",
      output_json: output,
      role_title: roleTitle,
      role_summary: roleSummary,
      skills,
      archetype,
      archetype_contrast: archetypeContrast,
      useful_to: usefulTo,
      data_caveat: dataCaveat,
      output_digest: outputDigest,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    runtimeSnapshots.set(normalizedId, next);
    return normalizeSnapshot(next);
  }

  try {
    const result = await query(
      `UPDATE profile_public_snapshots
          SET status = 'completed',
              output_json = $2::jsonb,
              role_title = $3,
              role_summary = $4,
              skills = $5::jsonb,
              archetype = $6,
              archetype_contrast = $7,
              useful_to = $8,
              data_caveat = $9,
              output_digest = $10,
              completed_at = now(),
              updated_at = now(),
              error_message = null
        WHERE snapshot_id = $1
        RETURNING *`,
      [
        normalizedId,
        JSON.stringify(output || {}),
        roleTitle,
        roleSummary,
        JSON.stringify(skills),
        archetype,
        archetypeContrast,
        usefulTo,
        dataCaveat,
        safeText(outputDigest, 160),
      ]
    );
    return normalizeSnapshot(result.rows[0] || null);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const original = await query(
      `SELECT account_id
         FROM profile_public_snapshots
        WHERE snapshot_id = $1
        LIMIT 1`,
      [normalizedId]
    ).catch(() => ({ rows: [] }));
    const current = await getLatestPublicProfileSnapshot({
      accountId: safeText(original.rows[0]?.account_id, 180),
    });
    return current;
  }
}

export async function failPublicProfileSnapshot({ snapshotId, errorMessage = "" } = {}) {
  const normalizedId = safeText(snapshotId, 160);
  if (!normalizedId) return null;

  if (!databaseEnabled()) {
    const row = runtimeSnapshots.get(normalizedId);
    if (!row) return null;
    const next = {
      ...row,
      status: "failed",
      error_message: safeText(errorMessage, 1200),
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    runtimeSnapshots.set(normalizedId, next);
    return normalizeSnapshot(next);
  }

  const result = await query(
    `UPDATE profile_public_snapshots
        SET status = 'failed',
            error_message = $2,
            completed_at = now(),
            updated_at = now()
      WHERE snapshot_id = $1
      RETURNING *`,
    [normalizedId, safeText(errorMessage, 1200)]
  );
  return normalizeSnapshot(result.rows[0] || null);
}

export function publicProfileWalletsFromInput(input = {}) {
  return uniqueWalletAddresses((input.identity?.wallets || []).map((wallet) => wallet.walletAddress));
}
