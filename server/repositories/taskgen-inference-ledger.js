import { databaseEnabled, transaction } from "../db/pool.js";
import { insertLedgerEntry } from "./chat-billing.js";

// Task generation inference is paid by Task Node, not by the requesting user.
// Each completed gateway call made while generating a task is still recorded
// against the account it served, as a zero-amount `taskgen_inference` ledger
// entry: amount_usd = 0 (no change to the account's spend or credit), with the
// gateway-reported cost in provider_cost_usd and the token counts alongside.
// Charging users for it would be a pricing decision; this only attributes it.
export const TASKGEN_INFERENCE_LEDGER_KIND = "taskgen_inference";

function text(value = "", max = 180) {
  return String(value ?? "").trim().slice(0, max);
}

export async function recordTaskgenInferenceSpend({
  accountId = "",
  requestId = "",
  attemptId = "",
  source = "task_generation",
  outcome = "",
  completions = [],
} = {}) {
  const account = text(accountId, 160);
  const attempt = text(attemptId, 120);
  const rows = Array.isArray(completions) ? completions : [];
  if (!databaseEnabled() || !account || !attempt || !rows.length) {
    return { ok: true, recorded: 0, skipped: true };
  }
  const inserted = await transaction(async (client) => {
    const entries = [];
    for (const [index, completion] of rows.entries()) {
      const costReported = completion.providerCostUsd !== null && completion.providerCostUsd !== undefined;
      const entry = await insertLedgerEntry(client, {
        kind: TASKGEN_INFERENCE_LEDGER_KIND,
        accountId: account,
        amountUsd: 0,
        source: text(source, 80),
        note: "Task generation inference attributed to this account; paid by Task Node, not debited.",
        createdBy: "task_generation_worker",
        provider: text(completion.provider, 40),
        model: text(completion.model, 160),
        mode: text(completion.capability, 60),
        responseId: text(completion.responseId, 180),
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        totalTokens: completion.totalTokens,
        webSearchCalls: completion.webSearchCalls,
        providerCostUsd: costReported ? completion.providerCostUsd : null,
        costSource: costReported ? "gateway_reported" : "gateway_cost_unreported",
        uniqueKey: `taskgen_inference:${attempt}:${index}`,
        onConflictUnique: true,
        metadata: {
          billingImpact: "none",
          requestId: text(requestId),
          attemptId: attempt,
          sequence: index,
          outcome: text(outcome, 80),
          requestedModel: text(completion.requestedModel, 160),
          cachedInputTokens: completion.cachedInputTokens || 0,
          reasoningTokens: completion.reasoningTokens || 0,
          completedAt: completion.completedAt || "",
        },
      });
      if (entry) entries.push(entry);
    }
    return entries;
  });
  return {
    ok: true,
    recorded: inserted.length,
    providerCostUsd: Number(inserted.reduce((sum, entry) => sum + Number(entry.provider_cost_usd || 0), 0).toFixed(6)),
  };
}
