import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  generateMlDsa65Keypair,
  verifyEnvelopeRaw,
} from "./message-protocol.js";
import {
  NFT_MIGRATED_SERIAL_BIT,
  decodeNftMetadata,
} from "./nft-protocol.js";
import {
  DEFAULT_OFFICIAL_COLLECTION_ID,
  LEGACY_SOURCE_CHAIN,
  freezeEligibilityAllowlist,
  scanFounderNftInventory,
} from "./nft-inventory.js";
import {
  FileMigrationLedgerStore,
  NFT_FLAG_ISSUER_BURNABLE,
  NFT_FLAG_TRANSFERABLE,
  assertOfficialCollectionPolicy,
  createBurnFirstNftMigrator,
} from "./nft-burn-migrator.js";
import {
  CHAIN_L1V2,
  CHAIN_LEGACY,
  MIGRATION_STATUS,
  buildDualChainProfileNftsView,
  fetchL1AccountNftsPaginated,
  formatIssuerCollection,
  nftMigrationBadge,
} from "./dual-chain-nfts.js";

// The old chain as the migrator's look-up sees it: burns by token and claim-hash memo.
function oldChainBurnStub() {
  const burns = [];
  return {
    record(burn) {
      burns.push(burn);
      return burn;
    },
    find: async ({ nftokenId, claimHashHex }) =>
      burns.find((burn) => burn.nftokenId === nftokenId && burn.claimHashHex === claimHashHex) || null,
  };
}

function seed32(label) {
  return createHash("sha256").update(label, "utf8").digest();
}

const TOKEN_1 = "000800006203F49C21D5D6E022CB16DE3538F248662FC73C29ABA6A900000001";
const TOKEN_2 = "000800006203F49C21D5D6E022CB16DE3538F248662FC73C29ABA6A900000002";
const TOKEN_JUNK_POST_CUTOFF = "000800006203F49C21D5D6E022CB16DE3538F248662FC73C29ABA6A900000099";
const TOKEN_UNMATCHED = "000800006203F49C21D5D6E022CB16DE3538F248662FC73C29ABA6A900000077";

function buildFixtureInventory() {
  const migrationIssuer = generateMlDsa65Keypair(seed32("pillar4-migration-issuer"));
  const founder = generateMlDsa65Keypair(seed32("pillar4-founder-claimant"));
  const oldWallet = "rFounderLegacyWallet0000000000001";
  const mockNfts = [
    {
      nftTokenId: TOKEN_1,
      issuer: oldWallet,
      metadataUri: "ipfs://bafkreimeta1",
      metadataCid: "bafkreimeta1",
      imageCid: "bafkreiimg1",
      title: "Founder Portrait #1",
      description: "Historical Task Node portrait #1",
      mintTx: "AB".repeat(32),
      mintLedgerIndex: 1100000,
    },
    {
      nftTokenId: TOKEN_2,
      issuer: oldWallet,
      metadataUri: "ipfs://bafkreimeta2",
      metadataCid: "bafkreimeta2",
      imageCid: "bafkreiimg2",
      title: "Founder Portrait #2",
      description: "Historical PFTasks portrait #2",
      mintTx: "CD".repeat(32),
      mintLedgerIndex: 1150000,
    },
    {
      nftTokenId: TOKEN_JUNK_POST_CUTOFF,
      issuer: oldWallet,
      metadataUri: "ipfs://bafkreimetajunk",
      metadataCid: "bafkreimetajunk",
      imageCid: "bafkreiimgjunk",
      title: "Post-Cutoff Junk Mint",
      mintLedgerIndex: 1300000,
    },
    {
      nftTokenId: TOKEN_UNMATCHED,
      issuer: "rUnknownSpammer",
      metadataUri: "ipfs://bafkreimetaunmatched",
      metadataCid: "bafkreimetaunmatched",
      imageCid: "bafkreiimgunmatched",
      title: "Unmatched External NFT",
      mintLedgerIndex: 1050000,
    },
  ];
  return { migrationIssuer, founder, oldWallet, mockNfts };
}

test("Founder NFT inventory scanner joins Task Node + PFTasks records, blocks post-cutoff & unmatched junk, and freezes signed allowlist", async () => {
  const { migrationIssuer, founder, oldWallet, mockNfts } = buildFixtureInventory();

  const report = await scanFounderNftInventory({
    wallets: [oldWallet],
    migrationIssuerAccount: migrationIssuer.account,
    cutoffLedgerIndex: 1200000,
    tasknodeRecords: [{ id: "tn_1", nftTokenId: TOKEN_1, imageCid: "bafkreiimg1" }],
    pftasksRecords: [{ id: "pft_2", nftTokenId: TOKEN_2, imageCid: "bafkreiimg2" }],
    fetchWalletInventory: async ({ walletAddress }) => ({
      ok: true,
      walletAddress,
      accountExists: true,
      nfts: mockNfts,
    }),
  });

  assert.equal(report.summary.totalScanned, 4);
  assert.equal(report.summary.eligibleCount, 2);
  assert.equal(report.summary.ineligibleCount, 2);

  const byId = new Map(report.items.map((item) => [item.nftokenId, item]));
  assert.equal(byId.get(TOKEN_1).eligible, true);
  assert.equal(byId.get(TOKEN_1).provenanceSource, "tasknode");
  assert.ok((BigInt(byId.get(TOKEN_1).migratedSerial) & NFT_MIGRATED_SERIAL_BIT) !== 0n);

  assert.equal(byId.get(TOKEN_2).eligible, true);
  assert.equal(byId.get(TOKEN_2).provenanceSource, "pftasks");

  assert.equal(byId.get(TOKEN_JUNK_POST_CUTOFF).eligible, false);
  assert.ok(byId.get(TOKEN_JUNK_POST_CUTOFF).ineligibilityReasons.includes("minted_at_or_after_cutoff_ledger"));

  assert.equal(byId.get(TOKEN_UNMATCHED).eligible, false);
  assert.ok(byId.get(TOKEN_UNMATCHED).ineligibilityReasons.includes("not_in_tasknode_pftasks_or_founder_approved"));

  const frozen = freezeEligibilityAllowlist({ inventoryReport: report, founderSigner: founder });
  assert.equal(frozen.allowlist.entryCount, 2);
  assert.ok(frozen.allowlistCid.multibaseCid.startsWith("b"));
  assert.ok(frozen.signedEnvelope);
  const sigCheck = verifyEnvelopeRaw(Buffer.from(frozen.signedEnvelope.rawEnvelopeHex, "hex"), {
    expectedSenderAccount: founder.account,
  });
  assert.equal(sigCheck.ok, true);
});

test("Burn-first batch migrator enforces official policy, burns before minting, produces ZERO duplicates on re-run, and prevents burn-then-remint replay", async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "tn-nft-mig-"));
  try {
    const ledgerPath = path.join(tmpDir, "migration-ledger.json");
    const { migrationIssuer, founder, oldWallet, mockNfts } = buildFixtureInventory();
    const report = await scanFounderNftInventory({
      wallets: [oldWallet],
      migrationIssuerAccount: migrationIssuer.account,
      cutoffLedgerIndex: 1200000,
      tasknodeRecords: [{ id: "tn_1", nftTokenId: TOKEN_1, imageCid: "bafkreiimg1" }],
      pftasksRecords: [{ id: "pft_2", nftTokenId: TOKEN_2, imageCid: "bafkreiimg2" }],
      fetchWalletInventory: async () => ({ ok: true, accountExists: true, nfts: mockNfts }),
    });
    const frozen = freezeEligibilityAllowlist({ inventoryReport: report, founderSigner: founder });

    // Official Task Node policy rejects ISSUER_BURNABLE or non-zero transfer fee
    assert.throws(
      () => assertOfficialCollectionPolicy({ flags: NFT_FLAG_TRANSFERABLE | NFT_FLAG_ISSUER_BURNABLE }),
      /forbids_issuer_burnable/
    );
    assert.throws(
      () => assertOfficialCollectionPolicy({ flags: NFT_FLAG_TRANSFERABLE, issuerTransferFee: 100 }),
      /requires_zero_transfer_fee/
    );

    const steps = [];
    const pinnedBlocks = new Map();
    const mintedOnChain = new Map();
    let burnCalls = 0;
    let mintCalls = 0;

    const ledgerStore = new FileMigrationLedgerStore(ledgerPath);
    const oldChain = oldChainBurnStub();
    const migrator = createBurnFirstNftMigrator({
      allowlist: frozen.allowlist,
      allowlistCid: frozen.allowlistCid,
      ledgerStore,
      migrationIssuerSigner: migrationIssuer,
      claimantSigner: founder,
      newOwnerAccount: founder.account,
      pinRawBlock: async ({ bytes, cid, kind }) => {
        steps.push(`pin:${kind}`);
        pinnedBlocks.set(cid, Buffer.from(bytes));
      },
      burnOldChainNft: async ({ nftokenId, oldOwner, claimHashHex }) => {
        burnCalls += 1;
        steps.push(`burn:${nftokenId}`);
        return oldChain.record({
          txHash: `BURN_${nftokenId.slice(-8)}`,
          account: oldOwner,
          nftokenId,
          claimHashHex,
          ledgerIndex: 1250000 + burnCalls,
          validated: true,
        });
      },
      findOldChainBurn: oldChain.find,
      verifyOldChainBurn: async ({ txHash, nftokenId, expectedOldOwner, expectedClaimHashHex }) => {
        steps.push(`verify_burn:${nftokenId}`);
        return {
          txHash,
          account: expectedOldOwner,
          nftokenId,
          claimHashHex: expectedClaimHashHex,
          ledgerIndex: 1250010,
          validated: true,
        };
      },
      queryL1NftInfo: async (nftId) => mintedOnChain.get(nftId) || null,
      mintL1Nft: async (payload) => {
        mintCalls += 1;
        steps.push(`mint:${payload.nft_id}`);
        // Verify official Task Node collection policy on every mint!
        assert.equal(payload.flags, NFT_FLAG_TRANSFERABLE);
        assert.equal(payload.issuer_burnable, false);
        assert.equal(payload.transferable, true);
        assert.equal(payload.collection_flags, 0);
        assert.equal(payload.issuer_transfer_fee, 0);
        assert.equal(payload.issuer, migrationIssuer.account);
        assert.equal(payload.owner, founder.account);
        assert.equal(payload.collection_id, DEFAULT_OFFICIAL_COLLECTION_ID);

        // Verify signed pf.nft.metadata.v1 One-Hash Rule & issuer match!
        const metaCid = payload.metadata_uri.replace("ipfs://", "");
        const rawEnv = pinnedBlocks.get(metaCid);
        assert.ok(rawEnv, "metadata envelope must be pinned before mint");
        const verified = verifyEnvelopeRaw(rawEnv, {
          expectedMetadataHashSha3_384: payload.metadata_hash,
          expectedSenderAccount: payload.issuer,
        });
        assert.equal(verified.ok, true);
        const decodedMeta = decodeNftMetadata(verified.envelope.bodyBytes);
        assert.equal(decodedMeta.origin.sourceChain, LEGACY_SOURCE_CHAIN);
        assert.ok(decodedMeta.origin.burnTx.startsWith("BURN_"));
        assert.ok(decodedMeta.origin.claimCid?.multibaseCid);

        mintedOnChain.set(payload.nft_id, { ...payload, burned: false, mintedHeight: 5000 + mintCalls });
        return { txHash: `L1_MINT_${mintCalls}`, blockHeight: 5000 + mintCalls };
      },
    });

    const firstRun = await migrator.migrateBatch();
    assert.equal(firstRun.ok, true);
    assert.equal(firstRun.summary.migratedCount, 2);
    assert.equal(firstRun.summary.skippedCount, 0);
    assert.equal(burnCalls, 2);
    assert.equal(mintCalls, 2);

    // Confirm strict burn-first ordering: pin claim BEFORE burn BEFORE pin metadata BEFORE mint!
    const firstBurnIdx = steps.indexOf(`burn:${TOKEN_1}`);
    const firstClaimIdx = steps.indexOf("pin:nft_claim");
    const firstMintIdx = steps.findIndex((s) => s.startsWith("mint:"));
    assert.ok(firstClaimIdx < firstBurnIdx, "claim must be pinned before burning");
    assert.ok(firstBurnIdx < firstMintIdx, "old NFT must be burned before minting on L1v2");

    // Re-run #2 using reloaded persistent ledger from disk -> ZERO burns, ZERO mints, ZERO duplicates!
    const reloadedLedger = new FileMigrationLedgerStore(ledgerPath);
    const secondMigrator = createBurnFirstNftMigrator({
      allowlist: frozen.allowlist,
      allowlistCid: frozen.allowlistCid,
      ledgerStore: reloadedLedger,
      migrationIssuerSigner: migrationIssuer,
      claimantSigner: founder,
      newOwnerAccount: founder.account,
      burnOldChainNft: async () => {
        burnCalls += 1;
        throw new Error("should_never_burn_on_rerun");
      },
      mintL1Nft: async () => {
        mintCalls += 1;
        throw new Error("should_never_mint_on_rerun");
      },
    });

    const secondRun = await secondMigrator.migrateBatch();
    assert.equal(secondRun.ok, true);
    assert.equal(secondRun.summary.migratedCount, 0);
    assert.equal(secondRun.summary.skippedCount, 2);
    assert.equal(burnCalls, 2);
    assert.equal(mintCalls, 2);

    // Adversarial burn-then-remint replay after burning on postfiatl1v2 + wiping local ledger!
    for (const nft of mintedOnChain.values()) {
      nft.burned = true;
    }
    const freshEmptyLedger = new FileMigrationLedgerStore("");
    const replayMigrator = createBurnFirstNftMigrator({
      allowlist: frozen.allowlist,
      ledgerStore: freshEmptyLedger,
      migrationIssuerSigner: migrationIssuer,
      claimantSigner: founder,
      queryL1NftInfo: async (nftId) => mintedOnChain.get(nftId) || null,
      burnOldChainNft: async () => {
        throw new Error("should_never_reburn");
      },
      mintL1Nft: async () => {
        throw new Error("should_never_remint_after_l1_burn");
      },
    });
    const replayRun = await replayMigrator.migrateBatch();
    assert.equal(replayRun.summary.migratedCount, 0);
    assert.equal(replayRun.summary.skippedCount, 2);
    assert.equal(replayRun.results[0].reason, "nft_serial_already_used_after_burn");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Partial-failure resume recovers cleanly after burn without re-burning and rejects forged burn proofs", async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "tn-nft-resume-"));
  try {
    const ledgerPath = path.join(tmpDir, "resume-ledger.json");
    const { migrationIssuer, founder, oldWallet, mockNfts } = buildFixtureInventory();
    const report = await scanFounderNftInventory({
      wallets: [oldWallet],
      migrationIssuerAccount: migrationIssuer.account,
      cutoffLedgerIndex: 1200000,
      tasknodeRecords: [{ id: "tn_1", nftTokenId: TOKEN_1, imageCid: "bafkreiimg1" }],
      pftasksRecords: [{ id: "pft_2", nftTokenId: TOKEN_2, imageCid: "bafkreiimg2" }],
      fetchWalletInventory: async () => ({ ok: true, accountExists: true, nfts: mockNfts }),
    });
    const frozen = freezeEligibilityAllowlist({ inventoryReport: report });

    let burnCountByToken = { [TOKEN_1]: 0, [TOKEN_2]: 0 };
    let mintAttempts = 0;

    // Run 1: TOKEN_1 succeeds; TOKEN_2 burns cleanly then crashes during L1 mint!
    const ledger1 = new FileMigrationLedgerStore(ledgerPath);
    const oldChain = oldChainBurnStub();
    const migrator1 = createBurnFirstNftMigrator({
      allowlist: frozen.allowlist,
      ledgerStore: ledger1,
      migrationIssuerSigner: migrationIssuer,
      claimantSigner: founder,
      pinRawBlock: async () => {},
      burnOldChainNft: async ({ nftokenId, oldOwner, claimHashHex }) => {
        burnCountByToken[nftokenId] += 1;
        return oldChain.record({ txHash: `BURN_${nftokenId.slice(-4)}`, account: oldOwner, nftokenId, claimHashHex, ledgerIndex: 1200001, validated: true });
      },
      findOldChainBurn: oldChain.find,
      mintL1Nft: async () => {
        mintAttempts += 1;
        if (mintAttempts === 2) throw new Error("l1_rpc_transient_outage");
        return { txHash: `MINT_${mintAttempts}`, blockHeight: 8000 + mintAttempts };
      },
    });

    const partial = await migrator1.migrateBatch();
    assert.equal(partial.ok, false);
    assert.equal(partial.summary.migratedCount, 1);
    assert.equal(partial.summary.failedCount, 1);
    assert.equal(burnCountByToken[TOKEN_1], 1);
    assert.equal(burnCountByToken[TOKEN_2], 1);

    // Run 2 (resume after outage): TOKEN_1 skipped, TOKEN_2 resumes straight to mint WITHOUT re-burning!
    const ledger2 = new FileMigrationLedgerStore(ledgerPath);
    assert.equal(ledger2.getItem(TOKEN_2).status, "metadata_signed_and_pinned");
    const migrator2 = createBurnFirstNftMigrator({
      allowlist: frozen.allowlist,
      ledgerStore: ledger2,
      migrationIssuerSigner: migrationIssuer,
      claimantSigner: founder,
      pinRawBlock: async () => {},
      burnOldChainNft: async ({ nftokenId }) => {
        burnCountByToken[nftokenId] += 1;
        throw new Error("must_not_reburn_already_burned_nft");
      },
      findOldChainBurn: oldChain.find,
      mintL1Nft: async () => {
        mintAttempts += 1;
        return { txHash: `MINT_${mintAttempts}`, blockHeight: 8000 + mintAttempts };
      },
    });

    const resumed = await migrator2.migrateBatch();
    assert.equal(resumed.ok, true);
    assert.equal(resumed.summary.skippedCount, 1);
    assert.equal(resumed.summary.migratedCount, 1);
    assert.equal(burnCountByToken[TOKEN_1], 1);
    assert.equal(burnCountByToken[TOKEN_2], 1);

    // Adversarial: forged burn_tx.account != old_owner is rejected before mint!
    const forgedLedger = new FileMigrationLedgerStore("");
    let forgedMintCalls = 0;
    const forgedChain = oldChainBurnStub();
    const forgedMigrator = createBurnFirstNftMigrator({
      allowlist: frozen.allowlist,
      ledgerStore: forgedLedger,
      migrationIssuerSigner: migrationIssuer,
      claimantSigner: founder,
      pinRawBlock: async () => {},
      burnOldChainNft: async ({ nftokenId, claimHashHex }) =>
        forgedChain.record({
          txHash: "FORGED_BURN",
          account: "rAttackerWalletNotOwner",
          nftokenId,
          claimHashHex,
          ledgerIndex: 1200010,
          validated: true,
        }),
      findOldChainBurn: forgedChain.find,
      mintL1Nft: async () => {
        forgedMintCalls += 1;
        return { txHash: "NEVER" };
      },
    });
    const forgedRes = await forgedMigrator.migrateBatch([TOKEN_1]);
    assert.equal(forgedRes.ok, false);
    assert.match(forgedRes.results[0].error, /old_chain_burn_account_mismatch/);
    assert.equal(forgedMintCalls, 0);

    // Optional pin-only mode: records provenance without burning or minting
    const pinOnlyLedger = new FileMigrationLedgerStore("");
    const pinOnlyMigrator = createBurnFirstNftMigrator({
      allowlist: frozen.allowlist,
      ledgerStore: pinOnlyLedger,
      migrationIssuerSigner: migrationIssuer,
      claimantSigner: founder,
      pinRawBlock: async () => {},
      anchorPinOnlyProvenance: async () => ({ txHash: "PROV_ANCHOR_TX_1" }),
    });
    const pinOnlyRes = await pinOnlyMigrator.migrateBatch([TOKEN_1], { mode: "pin_only" });
    assert.equal(pinOnlyRes.ok, true);
    assert.equal(pinOnlyRes.summary.recordedCount, 1);
    assert.equal(pinOnlyLedger.getProvenance(TOKEN_1).status, "recorded");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Dual-chain NFT read model merges legacy + postfiatl1v2 NFTs cleanly with badges and paginated RPC", async () => {
  const issuer = "pf" + "9".repeat(40);
  const owner = "pf" + "2".repeat(40);

  // Test paginated account_nfts cursor walking
  const pageCalls = [];
  const rpc = async (method, params) => {
    assert.equal(method, "account_nfts");
    pageCalls.push(params);
    if (!params.cursor) {
      return {
        total_count: 2,
        next_cursor: "a".repeat(96),
        nfts: [
          {
            nft_id: "a".repeat(96),
            issuer,
            collection_id: DEFAULT_OFFICIAL_COLLECTION_ID,
            serial: (NFT_MIGRATED_SERIAL_BIT + 1n).toString(),
            owner,
            metadata_uri: "ipfs://bafkreimigrated1",
            metadata_hash: "1".repeat(96),
            flags: 1,
            issuer_transfer_fee: 0,
            burned: false,
            origin: { nftoken_id: TOKEN_1, retirement_mode: "burn_first" },
          },
        ],
      };
    }
    return {
      total_count: 2,
      next_cursor: null,
      nfts: [
        {
          nft_id: "b".repeat(96),
          issuer,
          collection_id: DEFAULT_OFFICIAL_COLLECTION_ID,
          serial: "42",
          owner,
          metadata_uri: "ipfs://bafkreinative42",
          metadata_hash: "2".repeat(96),
          flags: 1,
          issuer_transfer_fee: 0,
          burned: false,
        },
      ],
    };
  };

  const paged = await fetchL1AccountNftsPaginated({ rpc, account: owner, limit: 1 });
  assert.equal(paged.pagesRead, 2);
  assert.equal(paged.nfts.length, 2);
  assert.equal(pageCalls[1].cursor, "a".repeat(96));

  // Merge with legacy NFTs (TOKEN_1 migrated, TOKEN_2 pin-only recorded, TOKEN_UNMATCHED not migrated)
  const view = buildDualChainProfileNftsView({
    legacyNfts: [
      { id: "leg_1", status: "minted", nftTokenId: TOKEN_1, title: "Portrait #1", imageCid: "bafkreiimg1", selected: true },
      { id: "leg_2", status: "minted", nftTokenId: TOKEN_2, title: "Portrait #2", imageCid: "bafkreiimg2" },
      { id: "leg_3", status: "minted", nftTokenId: TOKEN_UNMATCHED, title: "Portrait #3", imageCid: "bafkreiimg3" },
    ],
    l1Nfts: paged.nfts,
    provenanceRecords: [{ nftokenId: TOKEN_2, provenanceCid: "bafkreiprov2", status: "recorded", retirementMode: "pin_only" }],
  });

  // Zero duplicate cards for TOKEN_1 (merged into the migrated L1 card!)
  assert.equal(view.counts.total, 4);
  assert.equal(view.counts.migrated, 1);
  assert.equal(view.counts.nativeL1, 1);
  assert.equal(view.counts.recorded, 1);
  assert.equal(view.counts.notMigrated, 1);
  assert.equal(view.hasDualChain, true);

  const migratedCard = view.allNfts.find((n) => n.legacyTokenId === TOKEN_1);
  assert.equal(migratedCard.chain, CHAIN_L1V2);
  assert.equal(migratedCard.selected, true);
  assert.equal(nftMigrationBadge(migratedCard).label, "Migrated");
  assert.equal(nftMigrationBadge(migratedCard).canMigrate, false);
  assert.ok(formatIssuerCollection(migratedCard).includes(DEFAULT_OFFICIAL_COLLECTION_ID));
  assert.ok(formatIssuerCollection(migratedCard).includes("pf999999"));

  // Pin-only provenance renders strictly as "Recorded", never as a migrated live NFT
  const recordedCard = view.allNfts.find((n) => n.nftTokenId === TOKEN_2);
  assert.equal(recordedCard.chain, CHAIN_LEGACY);
  assert.equal(recordedCard.migrationStatus, MIGRATION_STATUS.RECORDED);
  assert.equal(nftMigrationBadge(recordedCard).label, "Recorded");
  assert.equal(nftMigrationBadge(recordedCard).isMigratedLiveNft, false);

  // Unmigrated legacy NFT shows "Not migrated" with canMigrate = true
  const legacyCard = view.allNfts.find((n) => n.nftTokenId === TOKEN_UNMATCHED);
  assert.equal(nftMigrationBadge(legacyCard).label, "Not migrated");
  assert.equal(nftMigrationBadge(legacyCard).canMigrate, true);

  // Chain filter returns exact subsets
  const l1Only = buildDualChainProfileNftsView({
    legacyNfts: [{ id: "leg_3", status: "minted", nftTokenId: TOKEN_UNMATCHED }],
    l1Nfts: paged.nfts,
    filter: "l1v2",
  });
  assert.equal(l1Only.nfts.length, 2);
});

// Review of PR 450, findings 10 and 11: a stub old chain and a stub postfiatl1v2 for stop-and-resume scenarios.
const STOP_TOKEN = "000800006203F49C21D5D6E022CB16DE3538F248662FC73C29ABA6A900000001";
const STOP_OWNER = "rOldOwner11111111111111111111111";
const stopAllowlist = { cutoffLedgerIndex: 1000, entries: [{ nftokenId: STOP_TOKEN, oldOwner: STOP_OWNER, mintLedgerIndex: 10, imageCid: "bafkreihash" }] };
const stopIssuer = generateMlDsa65Keypair(seed32("review-issuer"));
const stopClaimant = generateMlDsa65Keypair(seed32("review-claimant"));
class StopProcess extends Error {}

function stopWorld() {
  return { old: new Map([[STOP_TOKEN, STOP_OWNER]]), burns: new Map(), l1: new Map(), pendingBurns: false, burnCalls: 0, mintCalls: 0 };
}

function stopMigrator(w, file, opts = {}) {
  return createBurnFirstNftMigrator({
    allowlist: stopAllowlist,
    ledgerStore: new FileMigrationLedgerStore(file),
    migrationIssuerSigner: stopIssuer,
    claimantSigner: stopClaimant,
    pinRawBlock: async () => ({}),
    burnOldChainNft: async ({ nftokenId, oldOwner, claimHashHex }) => {
      w.burnCalls += 1;
      if (opts.checkIntent) opts.intentSeen = new FileMigrationLedgerStore(file).getItem(nftokenId)?.status;
      if (w.old.get(nftokenId) !== oldOwner) throw new Error("tecNO_ENTRY: no such NFT for this owner");
      w.old.delete(nftokenId);
      const txHash = `B${w.burns.size}`.padEnd(64, "0");
      w.burns.set(txHash, { account: oldOwner, nftokenId, claimHashHex, ledgerIndex: 1500 });
      if (opts.stopAfterBurn) throw new StopProcess("process stopped after burn applied");
      return { txHash, validated: !w.pendingBurns, account: oldOwner, nftokenId, claimHashHex };
    },
    findOldChainBurn: async ({ nftokenId, oldOwner, claimHashHex }) => {
      if (w.pendingBurns) return null;
      for (const [txHash, burn] of w.burns) {
        if (burn.nftokenId === nftokenId && burn.account === oldOwner && burn.claimHashHex === claimHashHex) {
          return { validated: true, txHash, ...burn };
        }
      }
      return null;
    },
    verifyOldChainBurn: opts.noVerify
      ? undefined
      : async ({ txHash }) => {
          const burn = w.burns.get(txHash);
          return burn && !w.pendingBurns ? { validated: true, txHash, ...burn } : null;
        },
    queryL1NftInfo: async (id) => {
      const nft = w.l1.get(id);
      if (!nft) return null;
      return { nft_id: id, owner: opts.wrongOwner ? "pf".padEnd(42, "0") : nft.owner, issuer: nft.issuer, metadata_hash: nft.metadata_hash, final: !opts.notFinal, height: 7 };
    },
    mintL1Nft: async (p) => {
      w.mintCalls += 1;
      if (opts.mintRefuses) return { ok: false, error: "nft_mint refused" };
      if (w.l1.has(p.nft_id)) throw new Error("duplicate nft_id");
      w.l1.set(p.nft_id, { ...p });
      return { txHash: "M".padEnd(64, "0"), blockHeight: 7 };
    },
  });
}

test("finding 10: a stop at any burn step loses nothing, and the burner is never called twice for one NFT", async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "tn-nft-stop-"));
  try {
    const cases = [
      ["B stop after the burn applied, before its hash was saved", { stopAfterBurn: true }],
      ["D no verify hook, stop after the burn applied", { stopAfterBurn: true, noVerify: true }],
      ["D2 no verify hook, the first burn answer not yet validated", { noVerify: true, pending: true }],
    ];
    for (const [label, opts] of cases) {
      const w = stopWorld();
      const file = path.join(tmpDir, `${label[0]}${label[1]}.json`);
      w.pendingBurns = Boolean(opts.pending);
      const runOpts = { ...opts, checkIntent: true };
      const first = await stopMigrator(w, file, runOpts).migrateBatch(null, {});
      assert.equal(first.ok, false, label);
      assert.equal(runOpts.intentSeen, "burn_intent", `${label}: burn_intent is durable before the burner runs`);
      w.pendingBurns = false;
      const rerun = await stopMigrator(w, file, { ...opts, stopAfterBurn: false }).migrateBatch(null, {});
      assert.equal(rerun.ok, true, `${label}: ${rerun.results[0].error || ""}`);
      assert.equal(w.old.has(STOP_TOKEN), false, label);
      assert.equal(w.l1.size, 1, `${label}: minted once`);
      assert.equal(w.burnCalls, 1, `${label}: one burn call`);
      assert.equal(new FileMigrationLedgerStore(file).getItem(STOP_TOKEN).status, "minted", label);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("finding 10: --execute needs a ledger path", async () => {
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const tmpDir = mkdtempSync(path.join(tmpdir(), "tn-nft-script-"));
  try {
    const allowlistPath = path.join(tmpDir, "allowlist.json");
    writeFileSync(allowlistPath, JSON.stringify(stopAllowlist));
    const script = new URL("../../scripts/nft-burn-migrate.mjs", import.meta.url).pathname;
    const run = spawnSync(process.execPath, [script, "--allowlist", allowlistPath, "--execute"], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /execute_requires_ledger_path/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
