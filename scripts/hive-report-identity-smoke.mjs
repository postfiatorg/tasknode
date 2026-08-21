import assert from "node:assert/strict";
import { hiveReportIdentityFallbackFromRow } from "../server/repositories/hive-reports.js";

const publicOnly = hiveReportIdentityFallbackFromRow({
  public_handle: "beau",
  evidence_json: {
    evidence: {
      provider: "x",
      followersCount: 31056,
      proofMethod: "x_public_metrics",
    },
  },
  validated_metrics_json: {
    followersCount: 31056,
    proofMethod: "x_public_metrics",
  },
});
assert.equal(publicOnly.publicHandle, "beau");
assert.equal(publicOnly.handle, "beau");
assert.equal(publicOnly.displayName, "beau");

const providerApproval = hiveReportIdentityFallbackFromRow({
  provider_handle: "@gmoney",
  provider_profile_url: "https://x.com/gmoney",
  evidence_json: {
    evidence: {
      provider: "x",
      followersCount: 318687,
      proofMethod: "x_public_metrics",
    },
  },
});
assert.equal(providerApproval.providerHandle, "gmoney");
assert.equal(providerApproval.profileUrl, "https://x.com/gmoney");
assert.equal(providerApproval.handle, "gmoney");

const nestedEvidence = hiveReportIdentityFallbackFromRow({
  evidence_json: {
    evidence: {
      username: "solarnius",
      profileUrl: "https://x.com/solarnius",
      followersCount: 6523,
    },
  },
});
assert.equal(nestedEvidence.providerHandle, "solarnius");
assert.equal(nestedEvidence.profileUrl, "https://x.com/solarnius");

console.log("hive-report-identity-smoke ok");
