import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import {
  ACCOUNT_FLAG_REFUSE_UNSOLICITED_ASSETS,
  ASSET_ACCESS_MIN_TIGHTEN_NOTICE_BLOCKS,
  MAX_CREDENTIAL_POLICY_OR_CLAUSES,
  buildAccountRefuseUnsolicitedOperation,
  buildAssetAccessSetOperation,
  buildBridgeHoldClaimOperation,
  buildBridgeHoldReturnOperation,
  buildCredentialAcceptOperation,
  buildCredentialDeleteOperation,
  classifyAccessPolicyChange,
  createDefaultLaunchComplianceConfig,
  describeLaunchMode,
  evaluatePrivacyLinkWarning,
  formatDidPftl,
  summarizeBridgeHold,
  validateComplianceConfig,
} from "./model.js";

const ISSUER = "pf1111111111111111111111111111111111111111";
const HOLDER = "pf2222222222222222222222222222222222222222";
const ASSET_ID = "99".repeat(48);
const ISSUER_ID_VC = "aa".repeat(48);
const ISSUER_ID_ZKP = "bb".repeat(48);
const CRED_ID = "cc".repeat(48);
const HOLD_KEY = "55".repeat(48);

test("permissionless-by-default launch config requires zero trust lines and forbids retroactive gating", () => {
  const def = createDefaultLaunchComplianceConfig();
  assert.equal(def.gated, false);
  assert.equal(def.requires_authorization, false);
  assert.equal(def.lapsed_exit_rule, "return_only");

  const desc = describeLaunchMode(def);
  assert.equal(desc.mode, "permissionless");
  assert.equal(desc.trustLinesRequired, false);
  assert.equal(desc.shieldedPoolsAllowed, true);

  // Retroactively enabling gating on an existing permissionless asset is rejected.
  const retroactive = validateComplianceConfig(
    { ...def, gated: true, requires_authorization: true },
    { existingAsset: { requires_authorization: false } },
  );
  assert.equal(retroactive.ok, false);
  assert.equal(retroactive.errors[0].code, "asset_gating_retroactive_enable_forbidden");

  // One-way opening (true -> false) is allowed.
  const openOp = buildAssetAccessSetOperation({
    issuer: ISSUER,
    assetId: ASSET_ID,
    disableAuthorizationPermanently: true,
  });
  assert.equal(openOp.operation.operation, "asset_access_set");
  assert.equal(openOp.operation.disable_authorization_permanently, true);
});

test("creator-chosen credential policy enforces OR/AND bounds, 7-day tightening notice, and emergency removal", () => {
  const gatedConfig = {
    gated: true,
    requires_authorization: true,
    approval_mode: "either",
    lapsed_exit_rule: "return_only",
    wrapper_mode: "pftl_plus_ethereum_free_wrapper",
    notice_blocks: ASSET_ACCESS_MIN_TIGHTEN_NOTICE_BLOCKS,
    credential_policy: {
      any_of: [
        { all_of: [{ issuer_id: ISSUER_ID_VC, credential_type: "kyc.vendor.example/kyc.basic" }] },
        { all_of: [{ issuer_id: ISSUER_ID_ZKP, credential_type: "zkpassport.org/passport.over18" }] },
      ],
    },
  };
  const valid = validateComplianceConfig(gatedConfig);
  assert.equal(valid.ok, true);

  // Exceeding 8 OR clauses rejected.
  const tooManyClauses = Array.from({ length: MAX_CREDENTIAL_POLICY_OR_CLAUSES + 1 }, () => ({
    all_of: [{ issuer_id: ISSUER_ID_VC, credential_type: "kyc.vendor.example/kyc.basic" }],
  }));
  assert.equal(
    validateComplianceConfig({ ...gatedConfig, credential_policy: { any_of: tooManyClauses } }).errors[0].code,
    "asset_access_policy_bounds_exceeded",
  );

  // Non-namespaced credential type rejected.
  assert.equal(
    validateComplianceConfig({
      ...gatedConfig,
      credential_policy: { any_of: [{ all_of: [{ issuer_id: ISSUER_ID_VC, credential_type: "kyc_basic" }] }] },
    }).errors[0].code,
    "issuer_invalid_credential_type",
  );

  // Tightening requires >= 7d notice; loosening is immediate.
  const tighten = classifyAccessPolicyChange(
    gatedConfig,
    { ...gatedConfig, approval_mode: "both" },
  );
  assert.equal(tighten.requiresNotice, true);
  assert.equal(tighten.requiredNoticeBlocks, ASSET_ACCESS_MIN_TIGHTEN_NOTICE_BLOCKS);

  // Emergency removal allowed immediately for deregistered or compromised issuer, blocked for healthy issuer.
  assert.equal(
    classifyAccessPolicyChange(null, null, { emergencyIssuer: { status: "deregistered", signing_accounts: [] } }).eligibleForEmergencyRemoval,
    true,
  );
  assert.equal(
    classifyAccessPolicyChange(null, null, { emergencyIssuer: { status: "active", signing_accounts: [{ account: ISSUER }] } }).eligibleForEmergencyRemoval,
    false,
  );

  // Operation builders match Train B contract.
  const setOp = buildAssetAccessSetOperation({ issuer: ISSUER, assetId: ASSET_ID, config: gatedConfig });
  assert.equal(setOp.operation.operation, "asset_access_set");
  assert.equal(setOp.operation.lapsed_exit_rule, "return_only");

  const acceptOp = buildCredentialAcceptOperation({ subject: HOLDER, credentialId: CRED_ID });
  assert.equal(acceptOp.operation.operation, "credential_accept");

  const deleteOp = buildCredentialDeleteOperation({ caller: HOLDER, credentialId: CRED_ID });
  assert.equal(deleteOp.operation.operation, "credential_delete");
  assert.equal(deleteOp.refundsDepositToIssuer, true);

  const refuseOp = buildAccountRefuseUnsolicitedOperation({ account: HOLDER, currentFlags: 1, refuseUnsolicited: true });
  assert.equal(refuseOp.operation.flags, 1 | ACCOUNT_FLAG_REFUSE_UNSOLICITED_ASSETS);
});

test("aggregated (asset, recipient) bridge-hold claim/return ops, did:pftl, and privacy notice work", () => {
  const hold = {
    hold_key: HOLD_KEY,
    asset_id: ASSET_ID,
    issuer: ISSUER,
    recipient: HOLDER,
    amount: 25_000_000,
    credit_count: 2,
    created_at_height: 124_400,
    last_updated_height: 124_488,
    last_reason_code: "asset_gate_recipient_ineligible",
  };

  // Uncredentialed holder cannot claim yet, but CAN return/burn under Return-only!
  const ineligibleSummary = summarizeBridgeHold(hold, { eligibleToClaim: false, lapsedExitRule: "return_only" });
  assert.equal(ineligibleSummary.canClaim, false);
  assert.equal(ineligibleSummary.canReturnOrBurn, true);
  assert.equal(ineligibleSummary.creditCount, 2);

  const returnOp = buildBridgeHoldReturnOperation({
    recipient: HOLDER,
    assetId: ASSET_ID,
    amount: 25_000_000,
    burn: false,
    hold,
  });
  assert.equal(returnOp.operation.operation, "bridge_hold_return");
  assert.equal(returnOp.allowedUnderReturnOnly, true);

  const claimOp = buildBridgeHoldClaimOperation({
    recipient: HOLDER,
    assetId: ASSET_ID,
    amount: 25_000_000,
    hold,
  });
  assert.equal(claimOp.operation.operation, "bridge_hold_claim");
  assert.throws(
    () => buildBridgeHoldClaimOperation({ recipient: HOLDER, assetId: ASSET_ID, amount: 30_000_000, hold }),
    (err) => err.code === "insufficient_bridge_hold_balance",
  );

  assert.equal(formatDidPftl("postfiat-wan-devnet-2", HOLDER), `did:pftl:postfiat-wan-devnet-2:${HOLDER}`);
  assert.equal(
    evaluatePrivacyLinkWarning({ hasPillar6Identity: true, usingSameAccount: true, isGatedFlow: true }).warn,
    true,
  );
  assert.equal(
    evaluatePrivacyLinkWarning({ hasPillar6Identity: true, usingSameAccount: false, isGatedFlow: true }).warn,
    false,
  );
});

test("PermissionlessLaunchToggle, ComplianceDrawer, and BridgeHoldClaimView render cleanly", async () => {
  const vite = await createServer({
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { entries: [], noDiscovery: true },
    server: { middlewareMode: true, hmr: false },
  });
  try {
    const { PermissionlessLaunchToggle } = await vite.ssrLoadModule("/src/features/navcoin-compliance/PermissionlessLaunchToggle.jsx");
    const { ComplianceDrawer } = await vite.ssrLoadModule("/src/features/navcoin-compliance/ComplianceDrawer.jsx");
    const { BridgeHoldClaimView } = await vite.ssrLoadModule("/src/features/navcoin-compliance/BridgeHoldClaimView.jsx");

    // 1. Permissionless default toggle
    const defConfig = createDefaultLaunchComplianceConfig();
    const toggleHtml = renderToStaticMarkup(React.createElement(PermissionlessLaunchToggle, {
      symbol: "OPEN",
      config: defConfig,
    }));
    assert.ok(toggleHtml.includes("Permissionless · No trust lines"));
    assert.ok(toggleHtml.includes("No trust lines required"));
    assert.ok(!toggleHtml.includes("Configure Compliance Drawer"));

    // 2. Closed drawer renders ZERO markup
    assert.equal(
      renderToStaticMarkup(React.createElement(ComplianceDrawer, { open: false, config: defConfig })),
      "",
    );

    // 3. Open compliance drawer shows W3C VC / ZK-Passport, Return-only disclosure, zero PII, and privacy warning
    const drawerHtml = renderToStaticMarkup(React.createElement(ComplianceDrawer, {
      open: true,
      assetId: ASSET_ID,
      issuerAccount: ISSUER,
      hasPillar6Identity: true,
      usingSameAccountAsIdentity: true,
      config: {
        ...defConfig,
        gated: true,
        requires_authorization: true,
        credential_policy: {
          any_of: [{ all_of: [{ issuer_id: ISSUER_ID_ZKP, credential_type: "zkpassport.org/passport.over18" }] }],
        },
      },
    }));
    assert.ok(drawerHtml.includes("W3C Verifiable Credential"));
    assert.ok(drawerHtml.includes("ZK-Passport"));
    assert.ok(drawerHtml.includes("Return-only exit disclosure"));
    assert.ok(drawerHtml.includes("Zero PII on chain"));
    assert.ok(drawerHtml.includes("Privacy notice"));
    assert.ok(drawerHtml.includes(`did:pftl:postfiat-wan-devnet-2:${ISSUER}`));

    // 4. Aggregated (asset, recipient) bridge-hold claim view
    const holdHtml = renderToStaticMarkup(React.createElement(BridgeHoldClaimView, {
      recipientAccount: HOLDER,
      holds: [{
        hold_key: HOLD_KEY,
        asset_id: ASSET_ID,
        issuer: ISSUER,
        recipient: HOLDER,
        amount: 25_000_000,
        credit_count: 2,
        last_reason_code: "asset_gate_recipient_ineligible",
      }],
      assetMetadataById: {
        [ASSET_ID]: { symbol: "GATED", precision: 6, eligibleToClaim: false, lapsedExitRule: "return_only" },
      },
    }));
    assert.ok(holdHtml.includes("25 GATED"));
    assert.ok(holdHtml.includes("2 aggregated bridge credits"));
    assert.ok(holdHtml.includes("Return to issuer"));
    assert.ok(holdHtml.includes("Burn held units"));
    assert.ok(holdHtml.includes("Claim to wallet"));
  } finally {
    await vite.close();
  }
});
