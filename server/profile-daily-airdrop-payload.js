import { createHash } from "node:crypto";
import { dailyAirdropDate } from "./profile-daily-airdrop-issuance-state.js";

const PFT_DROPS_PER_PFT = 1_000_000;

export function stableDailyAirdropJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableDailyAirdropJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableDailyAirdropJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function dailyAirdropDigest(value = "") {
  const input = typeof value === "string" ? value : stableDailyAirdropJson(value);
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function dailyAirdropPftToDrops(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return "0";
  return String(Math.round(parsed * PFT_DROPS_PER_PFT));
}

export function buildDailyAirdropPayload({ run, issuance, sourceWallet, recipientWallet, amountPft }) {
  return {
    schema: "pf.daily_airdrop.v1",
    protocol: "tasknode.pftl",
    created_at: new Date().toISOString(),
    chain: process.env.TASKNODE_PFTL_CHAIN_NAME || "pftl-testnet",
    run_id: run.id,
    issuance_id: issuance.id,
    event_id: `evt_${dailyAirdropDigest({ runId: run.id, recipientWallet, amountPft }).slice(0, 24)}`,
    account_id: run.account_id,
    actor_wallet: sourceWallet,
    authority_wallet: sourceWallet,
    allocation_wallet: sourceWallet,
    recipient_wallet_address: recipientWallet,
    reward_pft: Number(amountPft).toFixed(6),
    reward_tier: "daily_airdrop",
    reward_summary: run.what_raised_today || "",
    retention_value_score: Number(run.retention_value_score || 0),
    what_raised_today: run.what_raised_today || "",
    what_kept_it_lower: run.what_kept_it_lower || "",
    to_improve_tomorrow: run.to_improve_tomorrow || "",
    alignment_score_7d: Number(run.alignment_score_7d || 0),
    actual_airdrop_pft_7d: Number(run.actual_airdrop_pft_7d || 0),
    max_possible_airdrop_pft_7d: Number(run.max_possible_airdrop_pft_7d || 0),
    run_date: dailyAirdropDate(run.run_date),
    prompt_version: run.prompt_version || "",
    prompt_digest: run.prompt_digest || "",
    input_hash: run.input_hash || "",
  };
}
