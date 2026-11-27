import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import {
  NAV_FEE_MAX_ANNUAL_RATE_BPS,
  NAV_FEE_MAX_FIX_FEE_CAP_BPS,
  NAV_FEE_MAX_HWM_RATE_BPS,
  NAV_FEE_MAX_SPREAD_BPS,
  NAV_FEE_MIN_INCREASE_NOTICE_BLOCKS,
  PROTOCOL_BLOCKS_PER_DAY,
  buildNavFeeClaimOperation,
  buildNavFeeScheduleAttachOperation,
  buildNavFeeScheduleCancelOperation,
  buildNavFeeScheduleSetOperation,
  classifyScheduleChange,
  computePendingHikeCountdown,
  hasConfiguredFeeSchedule,
  previewEpochFeeAccrual,
  validateNavFeeScheduleInput,
} from "./model.js";

const ISSUER = "pf1111111111111111111111111111111111111111";
const RECIPIENT = "pf3333333333333333333333333333333333333333";
const ASSET_ID = "99".repeat(48);

const VALID_SCHEDULE = {
  annual_rate_bps: 100,
  hwm_rate_bps: 1000,
  issue_spread_bps: 50,
  redeem_spread_bps: 50,
  fix_fee_cap_bps: 25,
  recipient: RECIPIENT,
  increase_notice_blocks: NAV_FEE_MIN_INCREASE_NOTICE_BLOCKS,
  accrual_cap_blocks: PROTOCOL_BLOCKS_PER_DAY,
  rates_locked: false,
  disclosure_ref: "ipfs://bafkreiexample",
};

test("Pillar 7 validator enforces exact protocol caps (5%/yr, 50% HWM, 5% spread, 1% fix, 7d notice)", () => {
  assert.equal(validateNavFeeScheduleInput(VALID_SCHEDULE, { issuerAccount: ISSUER }).ok, true);

  // Exceeding each locked cap fails with exact code.
  assert.equal(
    validateNavFeeScheduleInput({ ...VALID_SCHEDULE, annual_rate_bps: NAV_FEE_MAX_ANNUAL_RATE_BPS + 1 }, { issuerAccount: ISSUER }).errors[0].code,
    "nav_fee_rate_cap_exceeded",
  );
  assert.equal(
    validateNavFeeScheduleInput({ ...VALID_SCHEDULE, hwm_rate_bps: NAV_FEE_MAX_HWM_RATE_BPS + 1 }, { issuerAccount: ISSUER }).errors[0].code,
    "nav_fee_rate_cap_exceeded",
  );
  assert.equal(
    validateNavFeeScheduleInput({ ...VALID_SCHEDULE, issue_spread_bps: NAV_FEE_MAX_SPREAD_BPS + 1 }, { issuerAccount: ISSUER }).errors[0].code,
    "nav_fee_rate_cap_exceeded",
  );
  assert.equal(
    validateNavFeeScheduleInput({ ...VALID_SCHEDULE, redeem_spread_bps: NAV_FEE_MAX_SPREAD_BPS + 1 }, { issuerAccount: ISSUER }).errors[0].code,
    "nav_fee_rate_cap_exceeded",
  );
  assert.equal(
    validateNavFeeScheduleInput({ ...VALID_SCHEDULE, fix_fee_cap_bps: NAV_FEE_MAX_FIX_FEE_CAP_BPS + 1 }, { issuerAccount: ISSUER }).errors[0].code,
    "nav_fee_rate_cap_exceeded",
  );
  assert.equal(
    validateNavFeeScheduleInput({ ...VALID_SCHEDULE, increase_notice_blocks: NAV_FEE_MIN_INCREASE_NOTICE_BLOCKS - 1 }, { issuerAccount: ISSUER }).errors[0].code,
    "nav_fee_notice_too_short",
  );
  assert.equal(
    validateNavFeeScheduleInput({ ...VALID_SCHEDULE, recipient: ISSUER }, { issuerAccount: ISSUER }).errors[0].code,
    "nav_fee_recipient_equals_issuer",
  );

  // One-way rates_locked blocks any fee increase or notice reduction, while permitting fee cuts & recipient rotation.
  const lockedActive = { ...VALID_SCHEDULE, rates_locked: true };
  assert.equal(
    validateNavFeeScheduleInput({ ...lockedActive, annual_rate_bps: 150 }, { issuerAccount: ISSUER, activeSchedule: lockedActive }).errors[0].code,
    "nav_fee_schedule_rates_locked",
  );
  assert.equal(
    validateNavFeeScheduleInput({ ...lockedActive, annual_rate_bps: 50, recipient: "pf4444444444444444444444444444444444444444" }, { issuerAccount: ISSUER, activeSchedule: lockedActive }).ok,
    true,
  );
});

test("schedule change classifier, countdown, and Train B operation builders work accurately", () => {
  const hike = classifyScheduleChange(VALID_SCHEDULE, { ...VALID_SCHEDULE, annual_rate_bps: 200 });
  assert.equal(hike.isIncrease, true);
  assert.equal(hike.requiredNoticeBlocks, NAV_FEE_MIN_INCREASE_NOTICE_BLOCKS);

  const shortenNotice = classifyScheduleChange(
    { ...VALID_SCHEDULE, increase_notice_blocks: NAV_FEE_MIN_INCREASE_NOTICE_BLOCKS * 2 },
    { ...VALID_SCHEDULE, increase_notice_blocks: NAV_FEE_MIN_INCREASE_NOTICE_BLOCKS },
  );
  assert.equal(shortenNotice.isIncrease, true);

  const cut = classifyScheduleChange(VALID_SCHEDULE, { ...VALID_SCHEDULE, annual_rate_bps: 50 });
  assert.equal(cut.isIncrease, false);
  assert.equal(cut.isDecrease, true);

  const countdown = computePendingHikeCountdown(
    {
      proposed_at_height: 100_000,
      effective_at_height: 100_000 + NAV_FEE_MIN_INCREASE_NOTICE_BLOCKS,
      is_increase: true,
      schedule: { ...VALID_SCHEDULE, annual_rate_bps: 200 },
    },
    100_000 + PROTOCOL_BLOCKS_PER_DAY,
  );
  assert.equal(countdown.blocksRemaining, NAV_FEE_MIN_INCREASE_NOTICE_BLOCKS - PROTOCOL_BLOCKS_PER_DAY);
  assert.equal(countdown.formattedRemaining, "6d 0h 0m");
  assert.equal(countdown.exitCapacityLocked, true);

  const attachOp = buildNavFeeScheduleAttachOperation({ issuer: ISSUER, assetId: ASSET_ID, schedule: VALID_SCHEDULE });
  assert.equal(attachOp.operation.operation, "nav_fee_schedule_attach");

  const setOp = buildNavFeeScheduleSetOperation({
    issuer: ISSUER,
    assetId: ASSET_ID,
    schedule: { ...VALID_SCHEDULE, annual_rate_bps: 200 },
    activeSchedule: VALID_SCHEDULE,
  });
  assert.equal(setOp.operation.operation, "nav_fee_schedule_set");
  assert.equal(setOp.change.isIncrease, true);

  const cancelOp = buildNavFeeScheduleCancelOperation({ issuer: ISSUER, assetId: ASSET_ID });
  assert.equal(cancelOp.operation.operation, "nav_fee_schedule_cancel");

  const claimOp = buildNavFeeClaimOperation({
    recipient: RECIPIENT,
    assetId: ASSET_ID,
    amount: 5000,
    unclaimedFeeUnits: 9265979203,
  });
  assert.equal(claimOp.operation.operation, "nav_fee_claim");
  assert.equal(claimOp.subjectToAssetGate, true);
  assert.throws(
    () => buildNavFeeClaimOperation({ recipient: RECIPIENT, assetId: ASSET_ID, amount: 10000, unclaimedFeeUnits: 5000 }),
    (err) => err.code === "nav_fee_insufficient_unclaimed",
  );
});

test("deterministic BigInt fee accrual preview matches Pillar 7 worked example to the exact atom", () => {
  // Pillar 7 & Train B §3.6 exact worked example:
  // V = 1_100_000_000_000, S = 1_000_000_000_000, H = 100_000_000, m = 100 bps, p = 1000 bps, dh = 315_360
  const accrual = previewEpochFeeAccrual({
    verifiedNetAssets: 1_100_000_000_000n,
    circulatingSupply: 1_000_000_000_000n,
    highWaterMarkNavPerUnit: 100_000_000n,
    annualRateBps: 100,
    hwmRateBps: 1000,
    deltaBlocks: 315_360,
    accrualCapBlocks: 1_000_000,
    precision: 8,
  });
  assert.equal(accrual.time_fee_value, 110_000_000n);
  assert.equal(accrual.nav_after_time_fee, 109_989_000n);
  assert.equal(accrual.hwm_fee_value, 9_989_000_000n);
  assert.equal(accrual.total_fee_value, 10_099_000_000n);
  assert.equal(accrual.minted_fee_units, 9_265_979_203n);
  assert.equal(accrual.nav_after, 108_990_100n);
  assert.equal(accrual.hwm_after, 108_990_100n);
  assert.equal(accrual.reason_code, "accrued");

  // S=0 fail-safe never throws.
  const zeroSupply = previewEpochFeeAccrual({ verifiedNetAssets: 1000n, circulatingSupply: 0n, highWaterMarkNavPerUnit: 100n });
  assert.equal(zeroSupply.reason_code, "zero_supply");
  assert.equal(zeroSupply.minted_fee_units, 0n);
});

test("NavFeePanel renders ZERO clutter when disabled and full neutral countdown + cancel when active", async () => {
  const vite = await createServer({
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { entries: [], noDiscovery: true },
    server: { middlewareMode: true, hmr: false },
  });
  try {
    const { NavFeePanel } = await vite.ssrLoadModule("/src/features/navcoin-fees/NavFeePanel.jsx");

    // 1. Unscheduled NAVCoin on holder screen -> literally ZERO markup!
    assert.equal(hasConfiguredFeeSchedule({ has_fee_schedule: false, fee_state: null }), false);
    const hiddenHtml = renderToStaticMarkup(React.createElement(NavFeePanel, {
      assetId: ASSET_ID,
      symbol: "ZERO",
      feeReport: { has_fee_schedule: false, fee_state: null },
      allowOptIn: false,
    }));
    assert.equal(hiddenHtml, "");

    // 2. Opt-in creator screen when disabled -> minimal switch, zero rate fields / hedge-fund language.
    const optInHtml = renderToStaticMarkup(React.createElement(NavFeePanel, {
      assetId: ASSET_ID,
      symbol: "OPEN",
      feeReport: { has_fee_schedule: false, fee_state: null },
      allowOptIn: true,
    }));
    assert.ok(optInHtml.includes("Optional fee schedule"));
    assert.ok(optInHtml.includes("Disabled by default"));
    assert.ok(!optInHtml.includes("High-water-mark rate"));

    // 3. Active schedule with pending fee hike countdown + cancel button + neutral terminology.
    const activeHtml = renderToStaticMarkup(React.createElement(NavFeePanel, {
      assetId: ASSET_ID,
      symbol: "A666",
      issuerAccount: ISSUER,
      viewerAccount: RECIPIENT,
      canManage: true,
      currentBlockHeight: 200_000,
      reserveSplit: { provenValue: 750_000, attestedValue: 250_000 },
      feeReport: {
        has_fee_schedule: true,
        block_height: 200_000,
        fee_state: {
          active: VALID_SCHEDULE,
          pending: {
            schedule: { ...VALID_SCHEDULE, annual_rate_bps: 250 },
            proposed_at_height: 150_000,
            effective_at_height: 150_000 + NAV_FEE_MIN_INCREASE_NOTICE_BLOCKS,
            is_increase: true,
          },
          high_water_mark_nav_per_unit: 108_990_100,
          last_accrual_height: 199_000,
          unclaimed_fee_units: 9_265_979_203,
        },
      },
    }));
    assert.ok(activeHtml.includes("Pending fee increase notice"));
    assert.ok(activeHtml.includes("Cancel pending fee change"));
    assert.ok(activeHtml.includes("Exit capacity cannot be reduced"));
    assert.ok(activeHtml.includes("75% proven · 25% attested"));
    assert.ok(activeHtml.includes("non-issuer attestor"));
    assert.ok(activeHtml.includes("Prepare nav_fee_claim"));

    // Neutral protocol language invariant: zero hedge-fund / investment-fund jargon.
    const lower = activeHtml.toLowerCase();
    for (const forbidden of ["hedge fund", "management fee", "performance fee", "carried interest", "investment fund", "aum"]) {
      assert.equal(lower.includes(forbidden), false, `Must not contain hedge-fund framing: ${forbidden}`);
    }
  } finally {
    await vite.close();
  }
});
