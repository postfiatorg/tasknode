import { requestJson } from "../../api";
const messages = {
  sign_in_required: "Sign in to continue.", validator_required: "Bind a validator in Settings → Validator to use research.",
  validator_signature_invalid: "The signature does not match this key and challenge.",
  validator_challenge_invalid_or_expired: "This challenge expired or was already used. Create a new challenge.",
  validator_already_bound: "This validator is already bound to a Task Node account.",
  validator_unknown: "This key is not registered on devnet or testnet.", validator_revoked: "This validator key has been revoked.",
  research_credit_required: "Add credit in Settings → Billing. Research requires at least $0.50 available.",
  research_budget_exceeds_credit: "Your maximum cost exceeds your available credit.",
  research_not_configured: "Research is not available yet. Please try again later.",
};
export async function researchRequest(path, { method = "GET", body } = {}) {
  const result = await requestJson(path, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  if (!result.ok) throw new Error(messages[result.body?.error] || "This request could not be completed. Please try again.");
  return result.body;
}
