export function validatorNetworkLabel(network) {
  return { "l1-devnet": "L1 devnet", devnet: "Ledger devnet", testnet: "Ledger testnet", ledger: "Ledger" }[network] || "Validator";
}

export function validatorMenuStatus(bindings = []) {
  const networks = new Set(bindings.map(binding => binding.network === "l1-devnet" ? "L1" : "Ledger"));
  return networks.size ? `Connected · ${[...networks].sort().join(" + ")}` : "Connect";
}

export function validatorDate(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "Unknown";
}

export function validatorTooltip(bindings = []) {
  return bindings.map(binding => `Validator · ${validatorNetworkLabel(binding.network)} · linked ${validatorDate(binding.boundAt || binding.bound_at)}`).join("\n");
}

export function validatorEligibility(uptime, nextCheckDate) {
  const days = Number.isInteger(uptime?.daysReported) ? uptime.daysReported : 0;
  const participation = typeof uptime?.meanAgreement === "number" && Number.isFinite(uptime.meanAgreement) ? uptime.meanAgreement : null;
  const state = !uptime ? "unavailable" : uptime.eligible ? "on_track" : days < 25 ? "building_history"
    : participation !== null && participation < .95 ? "below_threshold" : "unavailable";
  const reason = {
    unavailable: "Participation history is temporarily unavailable.",
    on_track: "Meets the current thresholds. Eligibility is checked again at payout.",
    building_history: `${days} of 25 required days observed in the last 30 complete UTC days.`,
    below_threshold: "Mean participation is below the required 95%.",
  }[state];
  return { state, reason, daysObserved: days, requiredDays: 25, windowDays: 30,
    participation, requiredParticipation: .95, eligible: uptime?.eligible === true, nextCheckDate };
}

export function validatorRewardMonth(month) {
  const date = new Date(`${month}-01T00:00:00Z`);
  return month?.length === 7 && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 7) === month
    ? date.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : "Unknown month";
}

export function validatorRewardLedgerTitle(entry) {
  if (entry?.source !== "validator_reward" || entry.kind !== "reward_credit") return null;
  // The idempotency key records the payout month, including catch-up payments.
  const month = String(entry.uniqueKey || "").split(":").at(-1);
  const label = validatorRewardMonth(month);
  return label === "Unknown month" ? "Validator reward" : `Validator reward — ${label}`;
}
