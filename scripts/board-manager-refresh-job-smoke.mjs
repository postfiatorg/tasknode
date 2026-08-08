import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runBoardRepositoryRefreshJob } from "./board-manager-refresh-job.mjs";

const lockDir = path.join(os.tmpdir(), `board-manager-refresh-job-smoke-${process.pid}.lock`);
rmSync(lockDir, { recursive: true, force: true });

let releaseFirst;
const firstMayFinish = new Promise((resolve) => {
  releaseFirst = resolve;
});
let refreshCalls = 0;
let activeRefreshes = 0;
let peakRefreshes = 0;
const logs = [];

const refresh = async (boardId) => {
  refreshCalls += 1;
  activeRefreshes += 1;
  peakRefreshes = Math.max(peakRefreshes, activeRefreshes);
  if (boardId === "board_one") await firstMayFinish;
  activeRefreshes -= 1;
  return {
    boardId,
    refreshedAt: "2026-08-08T00:00:00.000Z",
    source_leads: [
      {
        repo: `${boardId}-repo`,
        fetch_verified: true,
        fetch_refreshed_at: "2026-08-08T00:00:00.000Z",
        checkout_relation: "synced",
      },
    ],
  };
};

try {
  const first = runBoardRepositoryRefreshJob({
    boardIds: ["board_one", "board_two"],
    lockDir,
    refresh,
    now: () => new Date("2026-08-08T00:00:00.000Z"),
    log: (line) => logs.push(line),
  });

  await new Promise((resolve) => setImmediate(resolve));
  const overlapping = await runBoardRepositoryRefreshJob({
    boardIds: ["board_one", "board_two"],
    lockDir,
    refresh,
    now: () => new Date("2026-08-08T00:00:01.000Z"),
    log: (line) => logs.push(line),
  });
  assert.deepEqual(overlapping, { ok: true, skipped: true, reason: "locked", boards: [] });
  assert.equal(refreshCalls, 1, "the overlapping job must not begin another refresh");

  releaseFirst();
  const completed = await first;
  assert.equal(completed.ok, true);
  assert.equal(completed.skipped, false);
  assert.equal(completed.boards.length, 2);
  assert.equal(refreshCalls, 2);
  assert.equal(peakRefreshes, 1, "boards must refresh sequentially within one job");
  assert.equal(logs.some((line) => line.includes("skipped=locked")), true);
  assert.equal(logs.some((line) => line.includes("fetch_refreshed_at=2026-08-08T00:00:00.000Z")), true);

  console.log(
    JSON.stringify({
      ok: true,
      overlappingRun: overlapping,
      refreshCalls,
      peakRefreshes,
      sample: logs.filter((line) => line.includes("fetch_refreshed_at=")),
    })
  );
} finally {
  releaseFirst?.();
  rmSync(lockDir, { recursive: true, force: true });
}
