import { requestJson } from "../api.js";

export function fetchHiveMindCoverage() {
  return requestJson("/api/hive-mind/coverage");
}

export function fetchHiveMindProfile() {
  return requestJson("/api/hive-mind/profile");
}

export function saveHiveMindProfile(payload) {
  return requestJson("/api/hive-mind/profile", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function fetchHiveMindMatches() {
  return requestJson("/api/hive-mind/matches");
}

export function startHiveMindInterview(payload) {
  return requestJson("/api/hive-mind/interviews/start", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function sendHiveMindInterviewMessage(payload) {
  return requestJson("/api/hive-mind/interviews/message", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function submitHiveMindClaim(payload) {
  return requestJson("/api/hive-mind/claims", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function fetchHiveMindProposals() {
  return requestJson("/api/hive-mind/proposals");
}

export function decideHiveMindProposal(payload) {
  return requestJson("/api/hive-mind/proposals/decide", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function fetchHiveMindInsights() {
  return requestJson("/api/hive-mind/insights");
}

export function fetchHiveMindRoi() {
  return requestJson("/api/hive-mind/roi");
}

export async function signClaimPayloadClient({ accountId, modelId, claimText, stance, signerKey }) {
  const signedAt = new Date().toISOString();
  const enc = new TextEncoder();
  const claimBuf = await crypto.subtle.digest("SHA-256", enc.encode(String(claimText || "").trim()));
  const claimHash = [...new Uint8Array(claimBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const canonicalPayload = JSON.stringify({
    accountId: String(accountId || "").trim(),
    modelId: String(modelId || "").trim(),
    stance: String(stance || "").trim(),
    claimHash,
    signedAt,
  });
  const sigBuf = await crypto.subtle.digest("SHA-256", enc.encode(`${signerKey}:${canonicalPayload}`));
  const signature = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return {
    scheme: "client_sha256_v1",
    identityType: "pseudonymous_key",
    publicKey: signerKey,
    signature,
    signedAt,
  };
}
