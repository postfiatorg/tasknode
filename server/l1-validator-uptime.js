import { dailyAgreement } from "./validator-identity.js";

// Preserve the current 30-day window, 25 observed-day minimum and 95% floor.
// PR #180's maximum observation gap is 900s: 96 scheduled probes per UTC day.
// Empty-block days count only with explicit per-validator uptime evidence.
export function l1UptimeEnabled(env = process.env) {
  return env.TASKNODE_L1_UPTIME_REWARDS_ENABLED === "true";
}

export function l1Uptime(row, asOf = new Date()) {
  const empty = dailyAgreement([], asOf);
  const held = { ...empty, available: false, qualifies: false, eligible: false, rewardsOnHold: true,
    eligibilityReason: "uptime_evidence_missing_or_invalid", metric: "uptime", timeBasis: "validator_probes",
    policy: "l1-uptime-v1", source: "l1_validator_uptime", daily: [] };
  const uptime = row?.uptime;
  if (!uptime || uptime.schema !== "postfiat-validator-uptime-v1" ||
      uptime.validator_id !== row.validator_id || uptime.ml_dsa_public_key !== row.ml_dsa_public_key ||
      uptime.time_basis !== "validator_probes" || uptime.cadence_seconds !== 900 ||
      Date.parse(uptime.window_start) !== Date.parse(empty.windowStart) ||
      Date.parse(uptime.window_end) !== Date.parse(empty.windowEnd) ||
      !Array.isArray(uptime.daily) || uptime.daily.length > 30) return held;
  const dates = new Set(), reports = [];
  for (const day of uptime.daily) {
    if (!day || typeof day.date !== "string" || day.date.length !== 10 ||
        !Number.isFinite(Date.parse(day.date)) || new Date(day.date).toISOString().slice(0, 10) !== day.date ||
        day.date < empty.windowStart.slice(0, 10) || day.date >= empty.windowEnd.slice(0, 10) || dates.has(day.date)) return held;
    dates.add(day.date);
    if (day.complete !== true) continue;
    if (day.expected_samples !== 96 || day.observed_samples !== 96 ||
        !Number.isSafeInteger(day.online_samples) || day.online_samples < 0 || day.online_samples > 96) return held;
    reports.push({ date: day.date, score: day.online_samples / day.expected_samples });
  }
  const measured = dailyAgreement(reports, asOf);
  const available = measured.daysReported >= 25;
  return { ...held, ...measured, available, qualifies: measured.eligible, rewardsOnHold: !available,
    eligibilityReason: !available ? "insufficient_uptime_observed_days" : measured.eligible ? "eligible" : "uptime_below_threshold",
    daily: uptime.daily };
}
