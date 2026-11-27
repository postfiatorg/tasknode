// Frozen Pillar 7 constants & deterministic helpers matching
// Big Milestone 07-navcoin-fees.md & L1 Upgrade Train B Contract Section 3.

export const PROTOCOL_BLOCKS_PER_DAY = 86_400;
export const PROTOCOL_BLOCKS_PER_7_DAYS = 604_800;
export const PROTOCOL_BLOCKS_PER_YEAR = 31_536_000;

export const NAV_FEE_SCHEDULE_ATTACH_KIND = "nav_fee_schedule_attach";
export const NAV_FEE_SCHEDULE_SET_KIND = "nav_fee_schedule_set";
export const NAV_FEE_SCHEDULE_CANCEL_KIND = "nav_fee_schedule_cancel";
export const NAV_FEE_CLAIM_KIND = "nav_fee_claim";

export const NAV_FEE_BPS_DENOMINATOR = 10_000;
export const NAV_FEE_MAX_ANNUAL_RATE_BPS = 500; // 5% / year
export const NAV_FEE_MAX_HWM_RATE_BPS = 5_000; // 50% of gain above high-water mark
export const NAV_FEE_MAX_SPREAD_BPS = 500; // 5% primary issue/redeem spread
export const NAV_FEE_MAX_FIX_FEE_CAP_BPS = 100; // 1% FX fix fee cap
export const NAV_FEE_MIN_INCREASE_NOTICE_BLOCKS = PROTOCOL_BLOCKS_PER_7_DAYS; // 604_800 (7d)
export const NAV_FEE_MAX_DISCLOSURE_REF_BYTES = 128;

export const DEFAULT_FEE_SCHEDULE_DRAFT = Object.freeze({
  annual_rate_bps: 0,
  hwm_rate_bps: 0,
  issue_spread_bps: 0,
  redeem_spread_bps: 0,
  fix_fee_cap_bps: 0,
  recipient: "",
  increase_notice_blocks: NAV_FEE_MIN_INCREASE_NOTICE_BLOCKS,
  accrual_cap_blocks: PROTOCOL_BLOCKS_PER_DAY,
  rates_locked: false,
  disclosure_ref: "",
});

export function isCanonicalL1Account(value) {
  return typeof value === "string" && /^pf[0-9a-f]{40}$/.test(value);
}

export function isAssetIdHex(value) {
  return typeof value === "string" && /^[0-9a-f]{96}$/.test(value);
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value || "")).length;
}

function toSafeInt(value, fallback = NaN) {
  if (value === "" || value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : NaN;
}

export function hasConfiguredFeeSchedule(feeScheduleReport) {
  if (!feeScheduleReport || typeof feeScheduleReport !== "object") return false;
  if (feeScheduleReport.has_fee_schedule === false) return false;
  const feeState = feeScheduleReport.fee_state || null;
  return Boolean(feeState && feeState.active && typeof feeState.active === "object");
}

export function hasNonZeroFeeRates(schedule) {
  if (!schedule || typeof schedule !== "object") return false;
  return (
    Number(schedule.annual_rate_bps || 0) > 0 ||
    Number(schedule.hwm_rate_bps || 0) > 0 ||
    Number(schedule.issue_spread_bps || 0) > 0 ||
    Number(schedule.redeem_spread_bps || 0) > 0 ||
    Number(schedule.fix_fee_cap_bps || 0) > 0
  );
}

export function formatBpsPercent(bps) {
  const n = Number(bps || 0);
  if (!Number.isFinite(n)) return "0%";
  const pct = n / 100;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(2).replace(/\.?0+$/, "")}%`;
}

export function formatBlockDuration(blocks) {
  const totalSeconds = Math.max(0, Math.floor(Number(blocks || 0)));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

export function formatUnitsFromAtoms(atoms, precision = 6) {
  const factor = 10n ** BigInt(precision);
  const value = BigInt(atoms ?? 0);
  const whole = value / factor;
  const frac = (value % factor).toString().padStart(precision, "0");
  const trimmedFrac = frac.replace(/0+$/, "");
  return trimmedFrac ? `${whole.toLocaleString("en-US")}.${trimmedFrac}` : whole.toLocaleString("en-US");
}

export function classifyScheduleChange(activeSchedule, nextSchedule) {
  if (!activeSchedule) {
    return {
      isIncrease: false,
      isDecrease: false,
      recipientChanged: false,
      changedFields: [],
      requiredNoticeBlocks: 0,
    };
  }
  const rateFields = [
    "annual_rate_bps",
    "hwm_rate_bps",
    "issue_spread_bps",
    "redeem_spread_bps",
    "fix_fee_cap_bps",
    "accrual_cap_blocks",
  ];
  let isIncrease = false;
  let isDecrease = false;
  const changedFields = [];

  for (const field of rateFields) {
    const prev = Number(activeSchedule[field] ?? 0);
    const next = Number(nextSchedule[field] ?? 0);
    if (next > prev) {
      isIncrease = true;
      changedFields.push({ field, previous: prev, next, direction: "increase" });
    } else if (next < prev) {
      isDecrease = true;
      changedFields.push({ field, previous: prev, next, direction: "decrease" });
    }
  }

  const prevNotice = Number(activeSchedule.increase_notice_blocks ?? NAV_FEE_MIN_INCREASE_NOTICE_BLOCKS);
  const nextNotice = Number(nextSchedule.increase_notice_blocks ?? NAV_FEE_MIN_INCREASE_NOTICE_BLOCKS);
  if (nextNotice < prevNotice) {
    isIncrease = true;
    changedFields.push({ field: "increase_notice_blocks", previous: prevNotice, next: nextNotice, direction: "increase" });
  } else if (nextNotice > prevNotice) {
    changedFields.push({ field: "increase_notice_blocks", previous: prevNotice, next: nextNotice, direction: "decrease" });
  }

  const recipientChanged = Boolean(nextSchedule.recipient && activeSchedule.recipient && nextSchedule.recipient !== activeSchedule.recipient);
  if (recipientChanged) {
    changedFields.push({
      field: "recipient",
      previous: activeSchedule.recipient,
      next: nextSchedule.recipient,
      direction: "change",
    });
  }

  const requiredNoticeBlocks = isIncrease
    ? Math.max(NAV_FEE_MIN_INCREASE_NOTICE_BLOCKS, prevNotice)
    : 0;

  return {
    isIncrease,
    isDecrease: !isIncrease && isDecrease,
    recipientChanged,
    changedFields,
    requiredNoticeBlocks,
  };
}

export function validateNavFeeScheduleInput(
  rawInput = {},
  { issuerAccount = "", activeSchedule = null, maxEpochGapBlocks = null } = {},
) {
  const errors = [];
  const annual = toSafeInt(rawInput.annual_rate_bps);
  const hwm = toSafeInt(rawInput.hwm_rate_bps);
  const issueSpread = toSafeInt(rawInput.issue_spread_bps);
  const redeemSpread = toSafeInt(rawInput.redeem_spread_bps);
  const fixCap = toSafeInt(rawInput.fix_fee_cap_bps);
  const noticeBlocks = toSafeInt(rawInput.increase_notice_blocks);
  const accrualCap = toSafeInt(rawInput.accrual_cap_blocks);
  const recipient = String(rawInput.recipient || "").trim();
  const ratesLocked = Boolean(rawInput.rates_locked);
  const disclosureRef = String(rawInput.disclosure_ref || "").trim();

  if (!Number.isSafeInteger(annual) || annual < 0 || annual > NAV_FEE_MAX_ANNUAL_RATE_BPS) {
    errors.push({
      code: "nav_fee_rate_cap_exceeded",
      field: "annual_rate_bps",
      message: `Annual rate must be between 0 and ${NAV_FEE_MAX_ANNUAL_RATE_BPS} bps (5%/year max).`,
    });
  }
  if (!Number.isSafeInteger(hwm) || hwm < 0 || hwm > NAV_FEE_MAX_HWM_RATE_BPS) {
    errors.push({
      code: "nav_fee_rate_cap_exceeded",
      field: "hwm_rate_bps",
      message: `High-water-mark rate must be between 0 and ${NAV_FEE_MAX_HWM_RATE_BPS} bps (50% max).`,
    });
  }
  if (!Number.isSafeInteger(issueSpread) || issueSpread < 0 || issueSpread > NAV_FEE_MAX_SPREAD_BPS) {
    errors.push({
      code: "nav_fee_rate_cap_exceeded",
      field: "issue_spread_bps",
      message: `Primary issue spread must be between 0 and ${NAV_FEE_MAX_SPREAD_BPS} bps (5% max).`,
    });
  }
  if (!Number.isSafeInteger(redeemSpread) || redeemSpread < 0 || redeemSpread > NAV_FEE_MAX_SPREAD_BPS) {
    errors.push({
      code: "nav_fee_rate_cap_exceeded",
      field: "redeem_spread_bps",
      message: `Primary redeem spread must be between 0 and ${NAV_FEE_MAX_SPREAD_BPS} bps (5% max).`,
    });
  }
  if (!Number.isSafeInteger(fixCap) || fixCap < 0 || fixCap > NAV_FEE_MAX_FIX_FEE_CAP_BPS) {
    errors.push({
      code: "nav_fee_rate_cap_exceeded",
      field: "fix_fee_cap_bps",
      message: `FX fix fee cap must be between 0 and ${NAV_FEE_MAX_FIX_FEE_CAP_BPS} bps (1% max).`,
    });
  }
  if (!Number.isSafeInteger(noticeBlocks) || noticeBlocks < NAV_FEE_MIN_INCREASE_NOTICE_BLOCKS) {
    errors.push({
      code: "nav_fee_notice_too_short",
      field: "increase_notice_blocks",
      message: `Fee-increase notice must be at least ${NAV_FEE_MIN_INCREASE_NOTICE_BLOCKS.toLocaleString("en-US")} blocks (7 days).`,
    });
  }
  if (!Number.isSafeInteger(accrualCap) || accrualCap < 1) {
    errors.push({
      code: "nav_fee_invalid_accrual_cap",
      field: "accrual_cap_blocks",
      message: "Accrual cap must be a positive block count.",
    });
  } else if (Number.isSafeInteger(maxEpochGapBlocks) && maxEpochGapBlocks > 0 && accrualCap > maxEpochGapBlocks) {
    errors.push({
      code: "nav_fee_invalid_accrual_cap",
      field: "accrual_cap_blocks",
      message: `Accrual cap cannot exceed max_epoch_gap_blocks (${maxEpochGapBlocks.toLocaleString("en-US")}).`,
    });
  }
  if (!isCanonicalL1Account(recipient)) {
    errors.push({
      code: "nav_fee_invalid_recipient",
      field: "recipient",
      message: "Fee recipient must be a canonical pf... account address.",
    });
  } else if (issuerAccount && recipient === issuerAccount) {
    errors.push({
      code: "nav_fee_recipient_equals_issuer",
      field: "recipient",
      message: "Fee recipient must be a distinct account from the NAVCoin issuer.",
    });
  }
  if (disclosureRef && utf8ByteLength(disclosureRef) > NAV_FEE_MAX_DISCLOSURE_REF_BYTES) {
    errors.push({
      code: "nav_fee_disclosure_ref_too_long",
      field: "disclosure_ref",
      message: `Disclosure reference must be <= ${NAV_FEE_MAX_DISCLOSURE_REF_BYTES} bytes.`,
    });
  }

  const normalized = {
    annual_rate_bps: annual,
    hwm_rate_bps: hwm,
    issue_spread_bps: issueSpread,
    redeem_spread_bps: redeemSpread,
    fix_fee_cap_bps: fixCap,
    recipient,
    increase_notice_blocks: noticeBlocks,
    accrual_cap_blocks: accrualCap,
    rates_locked: activeSchedule?.rates_locked ? true : ratesLocked,
    ...(disclosureRef ? { disclosure_ref: disclosureRef } : {}),
  };

  if (activeSchedule?.rates_locked && !ratesLocked) {
    errors.push({
      code: "nav_fee_schedule_rates_locked",
      field: "rates_locked",
      message: "Schedule lock is one-way and cannot be reversed once enabled.",
    });
  }

  const change = classifyScheduleChange(activeSchedule, normalized);
  if (activeSchedule?.rates_locked && change.isIncrease) {
    errors.push({
      code: "nav_fee_schedule_rates_locked",
      field: "rates_locked",
      message: "Rates are permanently locked; fee increases or shorter notice periods are rejected by consensus.",
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    schedule: normalized,
    change,
  };
}

export function computePendingHikeCountdown(pending, currentBlockHeight = 0) {
  if (!pending || typeof pending !== "object") return null;
  const nowHeight = Math.max(0, Number(currentBlockHeight || 0));
  const effectiveAt = Math.max(0, Number(pending.effective_at_height || 0));
  const proposedAt = Math.max(0, Number(pending.proposed_at_height || 0));
  const blocksRemaining = Math.max(0, effectiveAt - nowHeight);
  const totalWindow = Math.max(1, effectiveAt - proposedAt);
  const progressPct = effectiveAt <= proposedAt
    ? 100
    : Math.min(100, Math.max(0, Math.round(((nowHeight - proposedAt) / totalWindow) * 100)));
  const isEffective = nowHeight >= effectiveAt;
  return {
    isIncrease: Boolean(pending.is_increase),
    proposedAtHeight: proposedAt,
    effectiveAtHeight: effectiveAt,
    currentBlockHeight: nowHeight,
    blocksRemaining,
    formattedRemaining: isEffective ? "Activates on next epoch finalization" : formatBlockDuration(blocksRemaining),
    progressPct,
    isEffective,
    exitCapacityLocked: Boolean(pending.is_increase && !isEffective),
  };
}

export function buildNavFeeScheduleAttachOperation({
  issuer,
  assetId,
  schedule,
  maxEpochGapBlocks = null,
} = {}) {
  if (!isCanonicalL1Account(issuer)) throw new Error("Issuer must be a canonical pf... account.");
  if (!isAssetIdHex(assetId)) throw new Error("asset_id must be 96 lowercase hex characters.");
  const validated = validateNavFeeScheduleInput(schedule, { issuerAccount: issuer, maxEpochGapBlocks });
  if (!validated.ok) {
    const err = new Error(validated.errors[0].message);
    err.code = validated.errors[0].code;
    throw err;
  }
  return {
    kind: "asset",
    orderedConsensusRequired: true,
    operation: {
      operation: NAV_FEE_SCHEDULE_ATTACH_KIND,
      issuer,
      asset_id: assetId,
      schedule: validated.schedule,
    },
  };
}

export function buildNavFeeScheduleSetOperation({
  issuer,
  assetId,
  schedule,
  activeSchedule = null,
  maxEpochGapBlocks = null,
} = {}) {
  if (!isCanonicalL1Account(issuer)) throw new Error("Issuer must be a canonical pf... account.");
  if (!isAssetIdHex(assetId)) throw new Error("asset_id must be 96 lowercase hex characters.");
  const validated = validateNavFeeScheduleInput(schedule, {
    issuerAccount: issuer,
    activeSchedule,
    maxEpochGapBlocks,
  });
  if (!validated.ok) {
    const err = new Error(validated.errors[0].message);
    err.code = validated.errors[0].code;
    throw err;
  }
  return {
    kind: "asset",
    orderedConsensusRequired: true,
    change: validated.change,
    operation: {
      operation: NAV_FEE_SCHEDULE_SET_KIND,
      issuer,
      asset_id: assetId,
      schedule: validated.schedule,
    },
  };
}

export function buildNavFeeScheduleCancelOperation({ issuer, assetId } = {}) {
  if (!isCanonicalL1Account(issuer)) throw new Error("Issuer must be a canonical pf... account.");
  if (!isAssetIdHex(assetId)) throw new Error("asset_id must be 96 lowercase hex characters.");
  return {
    kind: "asset",
    orderedConsensusRequired: true,
    operation: {
      operation: NAV_FEE_SCHEDULE_CANCEL_KIND,
      issuer,
      asset_id: assetId,
    },
  };
}

export function buildNavFeeClaimOperation({ recipient, assetId, amount, unclaimedFeeUnits = null } = {}) {
  if (!isCanonicalL1Account(recipient)) throw new Error("Recipient must be a canonical pf... account.");
  if (!isAssetIdHex(assetId)) throw new Error("asset_id must be 96 lowercase hex characters.");
  const atoms = toSafeInt(amount);
  if (!Number.isSafeInteger(atoms) || atoms <= 0) {
    const err = new Error("Claim amount must be a positive integer in atoms.");
    err.code = "nav_fee_invalid_claim_amount";
    throw err;
  }
  if (unclaimedFeeUnits !== null && unclaimedFeeUnits !== undefined && BigInt(atoms) > BigInt(unclaimedFeeUnits)) {
    const err = new Error("Claim amount exceeds unclaimed fee units.");
    err.code = "nav_fee_insufficient_unclaimed";
    throw err;
  }
  return {
    kind: "asset",
    orderedConsensusRequired: true,
    subjectToAssetGate: true,
    operation: {
      operation: NAV_FEE_CLAIM_KIND,
      recipient,
      asset_id: assetId,
      amount: atoms,
    },
  };
}

// Exact BigInt 4-step deterministic accrual preview mirroring Train B Section 3.4.
export function previewEpochFeeAccrual({
  verifiedNetAssets,
  circulatingSupply,
  highWaterMarkNavPerUnit,
  annualRateBps = 0,
  hwmRateBps = 0,
  deltaBlocks = 0,
  accrualCapBlocks = PROTOCOL_BLOCKS_PER_DAY,
  precision = 6,
  maxSupply = null,
} = {}) {
  const V = BigInt(verifiedNetAssets ?? 0);
  const S = BigInt(circulatingSupply ?? 0);
  const U = 10n ** BigInt(precision);
  const H = BigInt(highWaterMarkNavPerUnit ?? 0);
  const m = BigInt(annualRateBps ?? 0);
  const p = BigInt(hwmRateBps ?? 0);
  const rawDelta = BigInt(Math.max(0, Number(deltaBlocks || 0)));
  const capDelta = BigInt(Math.max(0, Number(accrualCapBlocks || 0)));
  const dh = rawDelta < capDelta ? rawDelta : capDelta;
  const Y = BigInt(PROTOCOL_BLOCKS_PER_YEAR);
  const BPS = BigInt(NAV_FEE_BPS_DENOMINATOR);

  if (S === 0n) {
    return {
      reason_code: "zero_supply",
      time_fee_value: 0n,
      hwm_fee_value: 0n,
      total_fee_value: 0n,
      minted_fee_units: 0n,
      clipped_fee_units: 0n,
      supply_after: 0n,
      nav_after: 0n,
      hwm_after: H,
    };
  }
  if (V === 0n) {
    return {
      reason_code: "zero_net_assets",
      time_fee_value: 0n,
      hwm_fee_value: 0n,
      total_fee_value: 0n,
      minted_fee_units: 0n,
      clipped_fee_units: 0n,
      supply_after: S,
      nav_after: 0n,
      hwm_after: H,
    };
  }

  const navBefore = (V * U) / S;
  const Fm = (V * m * dh) / (BPS * Y);
  const Nm = ((V - Fm) * U) / S;
  const gain = Nm > H ? Nm - H : 0n;
  const Fp = (gain * S * p) / (BPS * U);
  const F = Fm + Fp;

  if (F >= V) {
    return {
      reason_code: "clamped_full_value",
      time_fee_value: Fm,
      nav_after_time_fee: Nm,
      hwm_fee_value: Fp,
      total_fee_value: F,
      minted_fee_units: 0n,
      clipped_fee_units: 0n,
      supply_after: S,
      nav_after: navBefore,
      hwm_after: H > navBefore ? H : navBefore,
    };
  }

  const rawMint = (F * S) / (V - F);
  let minted = rawMint;
  let clipped = 0n;
  let reasonCode = m === 0n && p === 0n ? "zero_rates" : dh === 0n && Fp === 0n ? "zero_delta_blocks" : "accrued";

  if (maxSupply !== null && maxSupply !== undefined) {
    const cap = BigInt(maxSupply);
    if (S + rawMint > cap) {
      minted = cap > S ? cap - S : 0n;
      clipped = rawMint - minted;
      reasonCode = "clamped_max_supply";
    }
  }

  const supplyAfter = S + minted;
  const navAfter = (V * U) / supplyAfter;
  const hwmAfter = navAfter > H ? navAfter : H;

  return {
    reason_code: reasonCode,
    blocks_per_year: Y,
    delta_blocks: dh,
    nav_before: navBefore,
    time_fee_value: Fm,
    nav_after_time_fee: Nm,
    hwm_fee_value: Fp,
    total_fee_value: F,
    minted_fee_units: minted,
    clipped_fee_units: clipped,
    supply_after: supplyAfter,
    nav_after: navAfter,
    hwm_after: hwmAfter,
  };
}

export function formatProvenVsAttestedSplit({ provenValue = 0, attestedValue = 0 } = {}) {
  const proven = Math.max(0, Number(provenValue || 0));
  const attested = Math.max(0, Number(attestedValue || 0));
  const total = proven + attested;
  if (total <= 0) {
    return { provenPct: 0, attestedPct: 0, hasAttested: false, requiresNonIssuerAttestor: false };
  }
  const provenPct = Math.round((proven / total) * 1000) / 10;
  const attestedPct = Math.round((attested / total) * 1000) / 10;
  return {
    provenPct,
    attestedPct,
    hasAttested: attested > 0,
    requiresNonIssuerAttestor: attested > 0,
  };
}
