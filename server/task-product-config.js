function envBoolean(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return ["1", "true", "yes", "on"].includes(normalized);
}

function envNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function taskProductConfig(env = process.env) {
  return {
    personalRequestEnabled: !envBoolean(env.TASKNODE_PERSONAL_TASKS_DISABLED, false),
    networkRequestEnabled: envBoolean(env.TASKNODE_NETWORK_TASKS_ENABLED, false),
    alphaRequestEnabled: envBoolean(env.TASKNODE_ALPHA_TASKS_ENABLED, false),
    dailyRewardCap: envNumber(env.TASKNODE_DAILY_REWARD_CAP_PFT, 8),
  };
}
