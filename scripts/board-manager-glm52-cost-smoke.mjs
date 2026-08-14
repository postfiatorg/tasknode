import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";
process.env.DATABASE_URL = "";
delete process.env.TASKNODE_BOARD_MANAGER_MODEL;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const { boardManagerModel, boardManagerProvider } = await import("../server/board-manager-decision-provider.js");
const {
  boardManagerCostWindowDays,
  readBoardManagerDailyCost,
} = await import("../server/system-status.js");

assert.equal(boardManagerModel("ambient"), "z-ai/glm-5.2");
assert.equal(boardManagerModel("unsupported"), "z-ai/glm-5.2");
process.env.TASKNODE_BOARD_MANAGER_PROVIDER = "legacy-provider-value";
assert.equal(boardManagerProvider(), "ambient");
assert.equal(boardManagerModel(), "z-ai/glm-5.2");
delete process.env.TASKNODE_BOARD_MANAGER_PROVIDER;
console.log("board-manager provider is pinned to Ambient regardless of legacy environment values");
process.env.TASKNODE_BOARD_MANAGER_MODEL = "override/model";
assert.equal(boardManagerModel("ambient"), "override/model");
delete process.env.TASKNODE_BOARD_MANAGER_MODEL;

assert.equal(boardManagerCostWindowDays(0), 1);
assert.equal(boardManagerCostWindowDays(120), 90);
assert.equal(boardManagerCostWindowDays("bad"), 30);

const queryCalls = [];
const dailyCost = await readBoardManagerDailyCost({
  databaseReady: true,
  tables: new Map([
    ["board_manager_runs", true],
    ["board_manager_secretary_packets", true],
  ]),
  days: 30,
  queryImpl: async (sql, params) => {
    queryCalls.push({ sql, params });
    return {
      rows: [
        {
          occurred_at: new Date("2026-06-19T15:00:00Z"),
          provider: "openrouter",
          model: "z-ai/glm-5.2",
          usage_json: {
            inputTokens: 1000,
            outputTokens: 2000,
            totalTokens: 3000,
          },
        },
        {
          occurred_at: new Date("2026-06-19T14:00:00Z"),
          provider: "deepseek",
          model: "deepseek-v4-pro",
          usage_json: {
            prompt_tokens: 500,
            completion_tokens: 100,
            total_tokens: 600,
            cost: 0.0002,
          },
        },
        {
          occurred_at: new Date("2026-06-18T12:00:00Z"),
          provider: "openrouter",
          model: "qwen/qwen3.7-max",
          usage_json: {
            input_tokens: 1000,
            output_tokens: 1000,
            total_tokens: 2000,
          },
        },
        {
          occurred_at: new Date("2026-06-18T13:00:00Z"),
          provider: "codex_exec",
          model: "qwen/qwen3.7-max",
          usage_json: {},
        },
        {
          occurred_at: new Date("2026-06-17T12:00:00Z"),
          provider: "deepseek",
          model: "deepseek-v4-pro",
          usage_json: {
            inputTokens: 1000,
            outputTokens: 1000,
            totalTokens: 2000,
          },
        },
      ],
    };
  },
});

assert.equal(queryCalls.length, 1);
assert.match(queryCalls[0].sql, /FROM board_manager_runs/);
assert.match(queryCalls[0].sql, /FROM board_manager_secretary_packets/);
assert.deepEqual(queryCalls[0].params, [30]);
assert.equal(dailyCost.enabled, true);
assert.equal(dailyCost.rows.length, 3);
assert.deepEqual(dailyCost.rows[0], {
  date: "2026-06-19",
  runs: 2,
  inputTokens: 1500,
  outputTokens: 2100,
  totalTokens: 3600,
  costUsd: 0.0096,
});
assert.deepEqual(dailyCost.rows[1], {
  date: "2026-06-18",
  runs: 1,
  inputTokens: 1000,
  outputTokens: 1000,
  totalTokens: 2000,
  costUsd: 0.01,
});
assert.deepEqual(dailyCost.rows[2], {
  date: "2026-06-17",
  runs: 1,
  inputTokens: 1000,
  outputTokens: 1000,
  totalTokens: 2000,
  costUsd: 0.001305,
});
assert.deepEqual(dailyCost.totals, {
  runs: 4,
  inputTokens: 3500,
  outputTokens: 4100,
  totalTokens: 7600,
  costUsd: 0.020905,
});

const disabledCost = await readBoardManagerDailyCost({
  databaseReady: false,
  tables: new Map(),
});
assert.equal(disabledCost.enabled, false);
assert.deepEqual(disabledCost.totals, {
  runs: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costUsd: 0,
});

function workerConfig(env = {}) {
  const output = execFileSync(process.execPath, ["scripts/board-manager-worker.mjs", "--print-config"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TASKNODE_DATABASE_DISABLED: "true",
      TASKNODE_POSTGRES_DISABLED: "true",
      DATABASE_URL: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return JSON.parse(output);
}

function assertLauncherRejectsRetiredProvider(scriptName) {
  assert.throws(
    () => execFileSync(process.execPath, [`scripts/${scriptName}`, "--provider", "openrouter"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TASKNODE_DATABASE_DISABLED: "true",
        TASKNODE_POSTGRES_DISABLED: "true",
        DATABASE_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    }),
    (error) => /board_manager_provider_unsupported:openrouter/.test(`${error?.stdout || ""}${error?.stderr || ""}`)
  );
}

for (const scriptName of ["board-manager-model-exec.mjs", "board-manager-loop.mjs", "board-manager-worker.mjs"]) {
  assertLauncherRejectsRetiredProvider(scriptName);
}

const defaultConfig = workerConfig({ TASKNODE_BOARD_MANAGER_CADENCE_SECONDS: "" });
assert.equal(defaultConfig.model, "z-ai/glm-5.2");
assert.equal(defaultConfig.reasoning, "high");
assert.equal(defaultConfig.cadenceSeconds, 300);

const overrideConfig = workerConfig({ TASKNODE_BOARD_MANAGER_CADENCE_SECONDS: "420" });
assert.equal(overrideConfig.cadenceSeconds, 420);

console.log("board-manager-glm52-cost-smoke ok");
