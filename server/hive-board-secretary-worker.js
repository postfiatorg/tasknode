import { hostname } from "node:os";
import { databaseEnabled } from "./db/pool.js";
import {
  hiveBoardSecretaryModel,
  hiveBoardSecretaryProvider,
  hiveBoardSecretaryProviderConfigured,
  fetchHiveBoardSecretaryMemo,
} from "./hive-board-secretary-provider.js";
import {
  buildHiveBoardSecretarySourcePacket,
  completeHiveBoardSecretaryMemo,
  failHiveBoardSecretaryMemo,
  listHiveBoardSecretaryProjects,
} from "./repositories/hive-board-secretary.js";
import {
  claimBoardManagerLease,
  releaseBoardManagerLease,
} from "./repositories/board-manager.js";

let timer = null;
let scheduled = null;
let running = false;
let currentLease = null;

const leaseScope = "hive_board_secretary:all_projects";
const managerId = `hive_board_secretary_${hostname()}_${process.pid}`;

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, env = process.env } = {}) {
  const parsed = Number(env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function cadenceMs(env = process.env) {
  return intEnv("TASKNODE_HIVE_BOARD_SECRETARY_CADENCE_SECONDS", 900, { min: 60, max: 86400, env }) * 1000;
}

function initialDelayMs(env = process.env) {
  return intEnv("TASKNODE_HIVE_BOARD_SECRETARY_INITIAL_DELAY_MS", 15000, { min: 0, max: 900000, env });
}

function projectLimit(env = process.env) {
  return intEnv("TASKNODE_HIVE_BOARD_SECRETARY_PROJECT_LIMIT", 100, { min: 1, max: 250, env });
}

function workerEnabled(env = process.env) {
  return (
    env.TASKNODE_HIVE_BOARD_SECRETARY_ENABLED !== "false" &&
    databaseEnabled() &&
    hiveBoardSecretaryProviderConfigured(env)
  );
}

export async function runHiveBoardSecretaryOnce({
  dryRun = false,
  fetchImpl = fetch,
  env = process.env,
  logger = console,
} = {}) {
  if (!databaseEnabled()) {
    return { ok: false, skipped: true, reason: "database_not_configured" };
  }
  if (!hiveBoardSecretaryProviderConfigured(env) && !dryRun) {
    return { ok: false, skipped: true, reason: "hive_board_secretary_provider_not_configured" };
  }
  const projects = await listHiveBoardSecretaryProjects({ limit: projectLimit(env) });
  const provider = hiveBoardSecretaryProvider();
  const model = hiveBoardSecretaryModel(env);
  const results = [];
  for (const project of projects) {
    let sourcePacket = null;
    try {
      sourcePacket = await buildHiveBoardSecretarySourcePacket({ projectId: project.id, now: new Date() });
      if (dryRun) {
        results.push({
          projectId: project.id,
          title: project.title,
          dryRun: true,
          sourcePacketDigest: sourcePacket.sourcePacketDigest,
          counts: sourcePacket.counts,
        });
        continue;
      }
      const memo = await fetchHiveBoardSecretaryMemo({
        sourcePacket,
        model,
        fetchImpl,
        env,
      });
      const completed = await completeHiveBoardSecretaryMemo({
        projectId: project.id,
        sourcePacket,
        memoMarkdown: memo.memoMarkdown,
        provider: memo.provider || provider,
        model: memo.model || model,
        promptVersion: memo.promptVersion,
        promptDigest: memo.promptDigest,
        usage: memo.usage,
      });
      results.push({
        projectId: project.id,
        title: project.title,
        ok: true,
        memoId: completed.memo?.id || "",
        sourcePacketDigest: sourcePacket.sourcePacketDigest,
      });
    } catch (error) {
      if (!dryRun) {
        await failHiveBoardSecretaryMemo({
          projectId: project.id,
          sourcePacket: sourcePacket || { projectId: project.id },
          error,
          provider,
          model,
        }).catch(() => null);
      }
      logger.warn?.("[hive-board-secretary] project failed", {
        projectId: project.id,
        error: error?.message || String(error),
      });
      results.push({
        projectId: project.id,
        title: project.title,
        ok: false,
        error: error?.message || String(error),
      });
    }
  }
  const failed = results.filter((result) => result.ok === false).length;
  const completed = results.filter((result) => result.ok === true).length;
  const summary = {
    scanned: projects.length,
    completed,
    failed,
    dryRun: Boolean(dryRun),
  };
  logger.log?.("[hive-board-secretary]", summary);
  return { ok: failed === 0, projects, results, summary };
}

async function processQueue({ env = process.env, logger = console } = {}) {
  if (running || !workerEnabled(env)) return;
  running = true;
  let lease = null;
  try {
    const ttlSeconds = Math.min(Math.max(Math.ceil(cadenceMs(env) / 1000) * 2, 600), 7200);
    lease = await claimBoardManagerLease({
      scope: leaseScope,
      managerId,
      ttlSeconds,
      metadata: {
        worker: "hive_board_secretary",
        cadenceMs: cadenceMs(env),
      },
    });
    if (!lease.ok) return;
    currentLease = lease;
    const result = await runHiveBoardSecretaryOnce({ env, logger });
    if (!result.ok) {
      logger.warn?.("[hive-board-secretary] run completed with failures", result.summary);
    }
  } finally {
    if (lease?.ok) {
      await releaseBoardManagerLease({ scope: leaseScope, managerId }).catch(() => null);
    }
    if (currentLease?.managerId === lease?.managerId) currentLease = null;
    running = false;
  }
}

export function scheduleHiveBoardSecretaryQueue({ delayMs = 0, env = process.env, logger = console } = {}) {
  if (!workerEnabled(env)) return false;
  if (scheduled) clearTimeout(scheduled);
  scheduled = setTimeout(() => {
    scheduled = null;
    processQueue({ env, logger }).catch((error) => {
      logger.warn?.("[hive-board-secretary] scheduled run failed", error?.message || error);
    });
  }, Math.max(0, Number(delayMs) || 0));
  scheduled.unref?.();
  return true;
}

export function startHiveBoardSecretaryWorker({ env = process.env, logger = console } = {}) {
  if (!workerEnabled(env)) return false;
  if (timer) return true;
  timer = setInterval(() => {
    processQueue({ env, logger }).catch((error) => {
      logger.warn?.("[hive-board-secretary] interval failed", error?.message || error);
    });
  }, cadenceMs(env));
  timer.unref?.();
  scheduleHiveBoardSecretaryQueue({ delayMs: initialDelayMs(env), env, logger });
  return true;
}

export async function stopHiveBoardSecretaryWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (scheduled) {
    clearTimeout(scheduled);
    scheduled = null;
  }
  const lease = currentLease;
  currentLease = null;
  if (lease?.ok) {
    await releaseBoardManagerLease({ scope: leaseScope, managerId }).catch(() => null);
  }
}
