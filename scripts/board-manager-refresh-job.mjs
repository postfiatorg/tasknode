#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { DETERMINISTIC_BOARD_IDS } from "../server/board-config.js";
import { closePool } from "../server/db/pool.js";
import { refreshBoardRepositories } from "./bm/lib.mjs";

const DEFAULT_STALE_LOCK_MS = 30 * 60 * 1000;

export function boardRefreshLockDir(env = process.env) {
  if (String(env.BM_REPO_REFRESH_LOCK_DIR || "").trim()) {
    return path.resolve(env.BM_REPO_REFRESH_LOCK_DIR);
  }
  const runtimeRoot = String(env.XDG_RUNTIME_DIR || "").trim() || os.tmpdir();
  return path.join(runtimeRoot, `tasknodeofficial-board-refresh-${process.getuid?.() ?? "user"}.lock`);
}

function lockOwnerIsAlive(lockDir) {
  try {
    const owner = JSON.parse(readFileSync(path.join(lockDir, "owner.json"), "utf8"));
    const pid = Number(owner?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function lockIsStale(lockDir, nowMs, staleLockMs) {
  try {
    return nowMs - statSync(lockDir).mtimeMs > staleLockMs;
  } catch {
    return false;
  }
}

export function tryAcquireBoardRefreshLock(
  lockDir,
  { now = () => new Date(), staleLockMs = DEFAULT_STALE_LOCK_MS } = {}
) {
  mkdirSync(path.dirname(lockDir), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockDir);
      writeFileSync(
        path.join(lockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, started_at: now().toISOString() })}\n`,
        "utf8"
      );
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const abandoned = !lockOwnerIsAlive(lockDir) && lockIsStale(lockDir, now().getTime(), staleLockMs);
      if (!abandoned) return false;
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
  return false;
}

export async function runBoardRepositoryRefreshJob({
  boardIds = DETERMINISTIC_BOARD_IDS,
  lockDir = boardRefreshLockDir(),
  refresh = refreshBoardRepositories,
  now = () => new Date(),
  log = console.log,
} = {}) {
  if (!tryAcquireBoardRefreshLock(lockDir, { now })) {
    log(`board_repository_refresh skipped=locked lock=${lockDir}`);
    return { ok: true, skipped: true, reason: "locked", boards: [] };
  }

  const boards = [];
  try {
    log(`board_repository_refresh started_at=${now().toISOString()} boards=${boardIds.length}`);
    for (const boardId of boardIds) {
      const result = await refresh(boardId);
      if (!result) throw new Error(`board not found: ${boardId}`);
      const sourceLeads = result.source_leads || [];
      boards.push({ boardId, refreshedAt: result.refreshedAt, sourceLeads });
      log(
        `board_repository_refresh board=${boardId} refreshed_at=${result.refreshedAt} sources=${sourceLeads.length}`
      );
      for (const lead of sourceLeads) {
        log(
          `  repo=${lead.repo} fetch_verified=${lead.fetch_verified} fetch_refreshed_at=${lead.fetch_refreshed_at || "never"} relation=${lead.checkout_relation}`
        );
      }
    }
    log(`board_repository_refresh completed_at=${now().toISOString()} boards=${boards.length}`);
    return { ok: true, skipped: false, boards };
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

async function main() {
  try {
    await runBoardRepositoryRefreshJob();
  } finally {
    await closePool();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(`board_repository_refresh failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
