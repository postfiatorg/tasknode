// Frozen Pillar 8 constants, policy validators & Train A/B operation builders.
// Mirrors Big Milestone 08-onchain-identity.md, Train A §4, and Train B §4.

export const ACCOUNT_FLAG_REQUIRE_MEMO = 0x0000_0001;
export const ACCOUNT_FLAG_REFUSE_UNSOLICITED_ASSETS = 0x0000_0002;
export const TRUSTLINE_STATE_EXPANSION_FEE = 10;
export const CREDENTIAL_DEPOSIT_ATOMS = 10_000; // 0.01 PFT refundable deposit

export const MAX_CREDENTIAL_POLICY_OR_CLAUSES = 8;
export const MAX_CREDENTIAL_POLICY_AND_PAIRS = 4;
export const ASSET_ACCESS_MIN_TIGHTEN_NOTICE_BLOCKS = 604_800; // 7 days
export const MAX_CLAWBACK_LOCKED_TARGETS = 64;

export const ASSET_ACCESS_SET_KIND = "asset_access_set";
export const CREDENTIAL_ACCEPT_KIND = "credential_accept";
export const CREDENTIAL_DELETE_KIND = "credential_delete";
export const BRIDGE_HOLD_CLAIM_KIND = "bridge_hold_claim";
export const BRIDGE_HOLD_RETURN_KIND = "bridge_hold_return";

export const APPROVAL_MODES = Object.freeze(["either", "both"]);
export const LAPSED_EXIT_RULES = Object.freeze(["return_only", "strict_freeze_clawback"]);
export const WRAPPER_MODES = Object.freeze(["pftl_only", "pftl_plus_ethereum_free_wrapper"]);

export const CREDENTIAL_PROVIDER_PRESETS = Object.freeze([
  {
    id: "w3c_vc_webhook",
    label: "W3C Verifiable Credential (Webhook Adapter)",
    adapterKind: "w3c_vc",
    sampleTypes: ["kyc.basic", "kyc.accredited"],
    summary: "External KYC vendor verifies off chain and submits an ML-DSA-65 signed salted commitment (zero PII on chain).",
  },
  {
    id: "zk_passport",
    label: "Open-Source ZK-Passport Verifier (Self / OpenPassport)",
    adapterKind: "zk_passport",
    sampleTypes: ["passport.verified", "passport.over18"],
    summary: "Zero-knowledge passport proof verified off chain and anchored as a lightweight ML-DSA-65 credential.",
  },
]);

export const BRIDGE_HOLD_REASON_COPY = Object.freeze({
  asset_gate_recipient_ineligible: "Recipient did not yet satisfy this gated asset's credential or authorization policy.",
  holder_limit_exceeded: "Incoming bridge credit exceeded the recipient's binding TrustLine holder_limit.",
  recipient_refuses_unsolicited_assets: "Recipient account has refuse_unsolicited_assets enabled with no existing holding line.",
});

export function isCanonicalL1Account(value) {
  return typeof value === "string" && /^pf[0-9a-f]{40}$/.test(value);
}

export function isHex96(value) {
  return typeof value === "string" && /^[0-9a-f]{96}$/.test(value);
}

export function isNamespacedCredentialType(value) {
  const s = String(value || "").trim();
  const slash = s.indexOf("/");
  if (slash < 3 || slash !== s.lastIndexOf("/")) return false;
  const domain = s.slice(0, slash);
  const typeName = s.slice(slash + 1);
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(typeName);
}

export function createDefaultLaunchComplianceConfig() {
  return {
    gated: false,
    requires_authorization: false,
    approval_mode: "either",
    lapsed_exit_rule: "return_only",
    wrapper_mode: "pftl_only",
    notice_blocks: ASSET_ACCESS_MIN_TIGHTEN_NOTICE_BLOCKS,
    credential_policy: { any_of: [] },
  };
}

export function describeLaunchMode(config = {}) {
  const gated = Boolean(config.gated || config.requires_authorization);
  if (!gated) {
    return {
      mode: "permissionless",
      label: "Permissionless (default)",
      trustLinesRequired: false,
      shieldedPoolsAllowed: true,
      retroactiveGatingAllowed: false,
      summary: "Anyone can receive, bid on, or hold this NAVCoin with zero trust_set step. Empty implicit lines auto-prune on zero balance.",
    };
  }
  const returnOnly = (config.lapsed_exit_rule || "return_only") === "return_only";
  return {
    mode: "gated",
    label: "Opt-in credential gated",
    trustLinesRequired: false,
    shieldedPoolsAllowed: false,
    retroactiveGatingAllowed: false,
    summary: returnOnly
      ? "Creator-chosen issuers gate transfers via live asset_gate checks. Return-only default guarantees expired/revoked holders can always redeem at NAV, burn, or return to issuer."
      : "Creator-chosen issuers gate transfers with strict freeze/clawback selected by the creator. Gated assets are barred from shielded pools in v1.",
  };
}

export function validateCredentialPolicy(policy = { any_of: [] }) {
  const errors = [];
  const clauses = Array.isArray(policy?.any_of) ? policy.any_of : [];
  if (clauses.length > MAX_CREDENTIAL_POLICY_OR_CLAUSES) {
    errors.push({
      code: "asset_access_policy_bounds_exceeded",
      message: `At most ${MAX_CREDENTIAL_POLICY_OR_CLAUSES} OR clauses are permitted.`,
    });
  }
  const normalizedClauses = [];
  for (let i = 0; i < clauses.length; i += 1) {
    const pairs = Array.isArray(clauses[i]?.all_of) ? clauses[i].all_of : [];
    if (pairs.length < 1 || pairs.length > MAX_CREDENTIAL_POLICY_AND_PAIRS) {
      errors.push({
        code: "asset_access_policy_bounds_exceeded",
        message: `Clause #${i + 1} must contain 1..=${MAX_CREDENTIAL_POLICY_AND_PAIRS} AND credential requirements.`,
      });
      continue;
    }
    const normalizedPairs = [];
    for (const pair of pairs) {
      const issuerId = String(pair?.issuer_id || "").trim().toLowerCase();
      const credType = String(pair?.credential_type || "").trim();
      if (!isHex96(issuerId)) {
        errors.push({
          code: "issuer_not_found",
          message: `Clause #${i + 1} has an invalid issuer_id (must be 96 lowercase hex).`,
        });
      }
      if (!isNamespacedCredentialType(credType)) {
        errors.push({
          code: "issuer_invalid_credential_type",
          message: `Credential type "${credType || "(empty)"}" must be domain-namespaced (e.g. vendor.example/kyc.basic).`,
        });
      }
      normalizedPairs.push({ issuer_id: issuerId, credential_type: credType });
    }
    normalizedClauses.push({ all_of: normalizedPairs });
  }
  return {
    ok: errors.length === 0,
    errors,
    policy: { any_of: normalizedClauses },
  };
}

export function validateComplianceConfig(config = {}, { existingAsset = null } = {}) {
  const errors = [];
  const gated = Boolean(config.gated || config.requires_authorization);

  if (existingAsset && existingAsset.requires_authorization === false && gated) {
    errors.push({
      code: "asset_gating_retroactive_enable_forbidden",
      message: "Permissionless assets can never retroactively turn gated (requires_authorization cannot flip false -> true).",
    });
  }

  const approvalMode = config.approval_mode || "either";
  if (!APPROVAL_MODES.includes(approvalMode)) {
    errors.push({ code: "invalid_approval_mode", message: "Approval mode must be either or both." });
  }
  const lapsedExitRule = config.lapsed_exit_rule || "return_only";
  if (!LAPSED_EXIT_RULES.includes(lapsedExitRule)) {
    errors.push({ code: "invalid_exit_rule", message: "Exit rule must be return_only or strict_freeze_clawback." });
  }
  const wrapperMode = config.wrapper_mode || "pftl_only";
  if (!WRAPPER_MODES.includes(wrapperMode)) {
    errors.push({ code: "invalid_wrapper_mode", message: "Wrapper mode must be pftl_only or pftl_plus_ethereum_free_wrapper." });
  }

  const noticeBlocks = Number(config.notice_blocks ?? ASSET_ACCESS_MIN_TIGHTEN_NOTICE_BLOCKS);
  if (!Number.isSafeInteger(noticeBlocks) || noticeBlocks < ASSET_ACCESS_MIN_TIGHTEN_NOTICE_BLOCKS) {
    errors.push({
      code: "asset_access_policy_bounds_exceeded",
      message: `Policy tightening notice must be at least ${ASSET_ACCESS_MIN_TIGHTEN_NOTICE_BLOCKS.toLocaleString("en-US")} blocks (7 days).`,
    });
  }

  const policyCheck = gated
    ? validateCredentialPolicy(config.credential_policy || { any_of: [] })
    : { ok: true, errors: [], policy: { any_of: [] } };
  errors.push(...policyCheck.errors);

  return {
    ok: errors.length === 0,
    errors,
    normalized: {
      gated,
      requires_authorization: gated,
      approval_mode: approvalMode,
      lapsed_exit_rule: lapsedExitRule,
      wrapper_mode: wrapperMode,
      notice_blocks: noticeBlocks,
      credential_policy: policyCheck.policy,
    },
  };
}

export function classifyAccessPolicyChange(currentPolicy = null, nextPolicy = null, { emergencyIssuer = null } = {}) {
  if (emergencyIssuer) {
    const isDeregistered = emergencyIssuer.status === "deregistered";
    const hasCutoff = Array.isArray(emergencyIssuer.signing_accounts)
      && emergencyIssuer.signing_accounts.some((s) => s?.compromise_cutoff_height != null);
    return {
      immediate: isDeregistered || hasCutoff,
      eligibleForEmergencyRemoval: isDeregistered || hasCutoff,
      reason: isDeregistered || hasCutoff
        ? "Immediate emergency removal allowed for deregistered or compromised issuer."
        : "Active uncompromised issuer cannot be removed via emergency escape hatch.",
    };
  }
  if (!currentPolicy || !nextPolicy) {
    return { immediate: true, requiresNotice: false, requiredNoticeBlocks: 0 };
  }
  const tightenedApproval = currentPolicy.approval_mode === "either" && nextPolicy.approval_mode === "both";
  const tightenedExit = currentPolicy.lapsed_exit_rule === "return_only" && nextPolicy.lapsed_exit_rule === "strict_freeze_clawback";
  const prevOrCount = currentPolicy.credential_policy?.any_of?.length || 0;
  const nextOrCount = nextPolicy.credential_policy?.any_of?.length || 0;
  const shortenedNotice = Number(nextPolicy.notice_blocks || 0) < Number(currentPolicy.notice_blocks || ASSET_ACCESS_MIN_TIGHTEN_NOTICE_BLOCKS);
  const tightenedClauses = nextOrCount < prevOrCount;
  const requiresNotice = tightenedApproval || tightenedExit || tightenedClauses || shortenedNotice;
  return {
    immediate: !requiresNotice,
    requiresNotice,
    requiredNoticeBlocks: requiresNotice
      ? Math.max(ASSET_ACCESS_MIN_TIGHTEN_NOTICE_BLOCKS, Number(currentPolicy.notice_blocks || ASSET_ACCESS_MIN_TIGHTEN_NOTICE_BLOCKS))
      : 0,
  };
}

export function buildAssetAccessSetOperation({
  issuer,
  assetId,
  config,
  existingAsset = null,
  disableAuthorizationPermanently = false,
  emergencyRemoveIssuerId = "",
} = {}) {
  if (!isCanonicalL1Account(issuer)) throw new Error("Issuer must be a canonical pf... account.");
  if (!isHex96(assetId)) throw new Error("asset_id must be 96 lowercase hex characters.");

  if (disableAuthorizationPermanently) {
    return {
      kind: "asset",
      orderedConsensusRequired: true,
      oneWayOpen: true,
      operation: {
        operation: ASSET_ACCESS_SET_KIND,
        issuer,
        asset_id: assetId,
        disable_authorization_permanently: true,
      },
    };
  }

  if (emergencyRemoveIssuerId) {
    const cleanId = String(emergencyRemoveIssuerId).trim().toLowerCase();
    if (!isHex96(cleanId)) throw new Error("emergency_remove_issuer_id must be 96 lowercase hex.");
    return {
      kind: "asset",
      orderedConsensusRequired: true,
      operation: {
        operation: ASSET_ACCESS_SET_KIND,
        issuer,
        asset_id: assetId,
        emergency_remove_issuer_id: cleanId,
      },
    };
  }

  const check = validateComplianceConfig(config, { existingAsset });
  if (!check.ok) {
    const err = new Error(check.errors[0].message);
    err.code = check.errors[0].code;
    throw err;
  }

  return {
    kind: "asset",
    orderedConsensusRequired: true,
    operation: {
      operation: ASSET_ACCESS_SET_KIND,
      issuer,
      asset_id: assetId,
      disable_authorization_permanently: false,
      approval_mode: check.normalized.approval_mode,
      lapsed_exit_rule: check.normalized.lapsed_exit_rule,
      wrapper_mode: check.normalized.wrapper_mode,
      credential_policy: check.normalized.credential_policy,
      notice_blocks: check.normalized.notice_blocks,
    },
  };
}

export function buildCredentialAcceptOperation({ subject, credentialId } = {}) {
  if (!isCanonicalL1Account(subject)) throw new Error("Subject must be a canonical pf... account.");
  const cleanId = String(credentialId || "").trim().toLowerCase();
  if (!isHex96(cleanId)) throw new Error("credential_id must be 96 lowercase hex.");
  return {
    kind: "asset",
    orderedConsensusRequired: true,
    operation: {
      operation: CREDENTIAL_ACCEPT_KIND,
      subject,
      credential_id: cleanId,
    },
  };
}

export function buildCredentialDeleteOperation({ caller, credentialId } = {}) {
  if (!isCanonicalL1Account(caller)) throw new Error("Caller must be a canonical pf... account.");
  const cleanId = String(credentialId || "").trim().toLowerCase();
  if (!isHex96(cleanId)) throw new Error("credential_id must be 96 lowercase hex.");
  return {
    kind: "asset",
    orderedConsensusRequired: true,
    refundsDepositToIssuer: true,
    operation: {
      operation: CREDENTIAL_DELETE_KIND,
      caller,
      credential_id: cleanId,
    },
  };
}

export function buildBridgeHoldClaimOperation({ recipient, assetId, amount, hold = null } = {}) {
  if (!isCanonicalL1Account(recipient)) throw new Error("Recipient must be a canonical pf... account.");
  if (!isHex96(assetId)) throw new Error("asset_id must be 96 lowercase hex characters.");
  const atoms = Number(amount);
  if (!Number.isSafeInteger(atoms) || atoms <= 0) {
    throw new Error("Claim amount must be a positive integer in atoms.");
  }
  if (hold && BigInt(atoms) > BigInt(hold.amount ?? 0)) {
    const err = new Error("Claim amount exceeds aggregated bridge-hold balance.");
    err.code = "insufficient_bridge_hold_balance";
    throw err;
  }
  return {
    kind: "asset",
    orderedConsensusRequired: true,
    operation: {
      operation: BRIDGE_HOLD_CLAIM_KIND,
      recipient,
      asset_id: assetId,
      amount: atoms,
    },
  };
}

export function buildBridgeHoldReturnOperation({ recipient, assetId, amount, burn = false, hold = null } = {}) {
  if (!isCanonicalL1Account(recipient)) throw new Error("Recipient must be a canonical pf... account.");
  if (!isHex96(assetId)) throw new Error("asset_id must be 96 lowercase hex characters.");
  const atoms = Number(amount);
  if (!Number.isSafeInteger(atoms) || atoms <= 0) {
    throw new Error("Return amount must be a positive integer in atoms.");
  }
  if (hold && BigInt(atoms) > BigInt(hold.amount ?? 0)) {
    const err = new Error("Return amount exceeds aggregated bridge-hold balance.");
    err.code = "insufficient_bridge_hold_balance";
    throw err;
  }
  return {
    kind: "asset",
    orderedConsensusRequired: true,
    allowedUnderReturnOnly: true,
    operation: {
      operation: BRIDGE_HOLD_RETURN_KIND,
      recipient,
      asset_id: assetId,
      amount: atoms,
      burn: Boolean(burn),
    },
  };
}

export function buildAccountRefuseUnsolicitedOperation({ account, currentFlags = 0, refuseUnsolicited = false } = {}) {
  if (!isCanonicalL1Account(account)) throw new Error("Account must be a canonical pf... account.");
  const base = Number(currentFlags || 0) & ~ACCOUNT_FLAG_REFUSE_UNSOLICITED_ASSETS;
  const nextFlags = refuseUnsolicited ? (base | ACCOUNT_FLAG_REFUSE_UNSOLICITED_ASSETS) : base;
  return {
    kind: "asset",
    orderedConsensusRequired: true,
    operation: {
      operation: "account_set",
      account,
      flags: nextFlags,
    },
  };
}

export function summarizeBridgeHold(hold = {}, { eligibleToClaim = false, lapsedExitRule = "return_only" } = {}) {
  const reasonCode = String(hold.last_reason_code || "asset_gate_recipient_ineligible");
  const canReturnOrBurn = lapsedExitRule === "return_only" || Boolean(eligibleToClaim);
  return {
    holdKey: hold.hold_key || "",
    assetId: hold.asset_id || "",
    issuer: hold.issuer || "",
    recipient: hold.recipient || "",
    amount: Number(hold.amount || 0),
    creditCount: Number(hold.credit_count || 0),
    createdAtHeight: Number(hold.created_at_height || 0),
    lastUpdatedHeight: Number(hold.last_updated_height || 0),
    reasonCode,
    reasonText: BRIDGE_HOLD_REASON_COPY[reasonCode] || `Routed to hold (${reasonCode}).`,
    canClaim: Boolean(eligibleToClaim) && Number(hold.amount || 0) > 0,
    canReturnOrBurn: canReturnOrBurn && Number(hold.amount || 0) > 0,
  };
}

export function formatDidPftl(chainId = "postfiat-wan-devnet-2", account = "") {
  if (!isCanonicalL1Account(account)) return "";
  return `did:pftl:${chainId}:${account}`;
}

export function evaluatePrivacyLinkWarning({ hasPillar6Identity = false, usingSameAccount = false, isGatedFlow = false } = {}) {
  if (!isGatedFlow || !hasPillar6Identity || !usingSameAccount) {
    return { warn: false, message: "" };
  }
  return {
    warn: true,
    message: "Privacy notice: this account holds a public Pillar 6 Hive identity. Use a separate Post Fiat L1 account for credentialed assets so on-chain KYC/passport status is not linked to your public handle.",
  };
}

export function formatAtoms(atoms, precision = 6) {
  const factor = 10n ** BigInt(precision);
  const value = BigInt(atoms ?? 0);
  const whole = value / factor;
  const frac = (value % factor).toString().padStart(precision, "0").replace(/0+$/, "");
  return frac ? `${whole.toLocaleString("en-US")}.${frac}` : whole.toLocaleString("en-US");
}
