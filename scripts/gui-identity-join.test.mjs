// Plan 06 criterion 3 regression: the GUI joins tasks, models (Finance Hub), GoodBrief
// (Finance Hub macro), initiatives (Hive projects), payments (linked wallet, rewarded-task
// history, daily airdrop) and validator status for ONE signed-in identity. Every surface
// below is read through the real route/module code the GUI calls, keyed only to the
// session's accountId, and a second control identity proves nothing leaks across.
// Requires a migrated PostgreSQL fixture database (scripts/run-smokes.mjs db, or
// DATABASE_URL + TASKNODE_DATABASE_ENABLED=true after scripts/migrate-db.mjs).
import assert from "node:assert/strict";
import { randomUUID, createCipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { deriveKeypair, generateSeed, sign } from "ripple-keypairs";
import { encodeNodePublic } from "ripple-address-codec";

import { closePool, query, databaseEnabled } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import { linkWalletToAccount } from "../server/repositories/account-wallets.js";
import { bindValidator, issueValidatorChallenge } from "../server/repositories/validator-bindings.js";
import { upsertIndex } from "../server/repositories/index-viewer.js";
import { appState } from "../server/app-state.js";
import { handleValidatorResearchRoute } from "../server/validator-research-routes.js";
import { handleValidatorBundleRoute } from "../server/validator-bundles.js";
import { handleHiveRoute } from "../server/hive-routes.js";
import { handleProfileRoute } from "../server/profile-routes.js";
import { getLinkedWallet } from "../server/repositories/account-wallets.js";
import { hasFinanceHubAccess, financeHubFrameSrc, FINANCE_HUB_BUNDLE_PATH } from "../src/features/research/finance-hub-route.js";
import { validatorMenuStatus, validatorTooltip } from "../shared/validator-display.js";

assert.ok(databaseEnabled(), "gui-identity-join needs an isolated PostgreSQL fixture database (DATABASE_URL + TASKNODE_DATABASE_ENABLED=true)");

const runId = randomUUID().slice(0, 8);
const primary = `gui_join_primary_${runId}`;
const control = `gui_join_control_${runId}`;
const primaryWallet = `rGuiJoinPrimary${runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10).padEnd(10, "X")}`;
const controlWallet = `rGuiJoinControl${runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10).padEnd(10, "X")}`;
const primaryTaskOutstanding = `task_guijoin_outstanding_${runId}`;
const primaryTaskRewarded = `task_guijoin_rewarded_${runId}`;
const controlTaskRewarded = `task_guijoin_control_${runId}`;
const initiative = `gui_join_initiative_${runId}`;
const controlInitiative = `gui_join_ctrl_initiative_${runId}`;
const airdropRun = `airdrop_run_guijoin_${runId}`;
const controlAirdropRun = `airdrop_run_guijoin_ctrl_${runId}`;

function jsonResponseCapture() {
  const response = {};
  return {
    response,
    json: (_res, status, body, headers) => { Object.assign(response, { status, body, headers }); },
  };
}

async function getRoute(handler, path, session, extra = {}) {
  const { response, json } = jsonResponseCapture();
  const handled = await handler({ json, req: { method: "GET", headers: {} }, res: {}, session, url: new URL(path, "https://tasknode.postfiat.org"), ...extra });
  assert.equal(handled, true, `${path} must be handled`);
  return response;
}

async function bundleRoute(path, session) {
  const response = {};
  const res = {
    writeHead: (status, headers) => Object.assign(response, { status, headers }),
    end: (body) => { response.body = body; },
  };
  const handled = await handleValidatorBundleRoute({
    json: (_res, status, body, headers) => Object.assign(response, { status, body, headers }),
    req: { method: "GET", headers: {} },
    res,
    session,
    url: new URL(path, "https://tasknode.postfiat.org"),
  });
  assert.equal(handled, true, `${path} must be handled by the bundle route`);
  return response;
}

try {
  await migrateDatabase();

  // ------------------------------------------------------------------ identity
  // Two accounts, each with a linked wallet. Only the primary identity binds a validator.
  for (const [accountId, address] of [[primary, primaryWallet], [control, controlWallet]]) {
    const linked = await linkWalletToAccount({ accountId, address, publicKey: `ed25519-${accountId}` });
    assert.equal(linked.ok, true, `${accountId} links its wallet`);
  }

  const key = deriveKeypair(generateSeed({ algorithm: "ed25519" }));
  const masterPublicKey = encodeNodePublic(Buffer.from(key.publicKey, "hex"));
  const challenge = await issueValidatorChallenge(primary);
  const binding = await bindValidator({
    accountId: primary,
    masterPublicKey,
    challenge: challenge.challenge,
    signature: sign(Buffer.from(challenge.challenge).toString("hex"), key.privateKey),
  }, { lookup: async () => ({ network: "devnet" }) });
  assert.ok(binding.id, "primary identity binds a validator");

  // --------------------------------------------------------------------- tasks
  // Primary: one outstanding and one rewarded task (with its reward event, which is also a
  // payment). Control: one rewarded task. Wallet+account scoped.
  await query(`INSERT INTO task_projections(task_id,account_id,subject_wallet,status,title,last_event_tx_hash,last_event_cid,event_count,source)
    VALUES ($1,$2,$3,'accepted','GUI join outstanding task','tx_guijoin_a','cid_guijoin_a',1,'direct_write')`,
    [primaryTaskOutstanding, primary, primaryWallet]);
  await query(`INSERT INTO task_projections(task_id,account_id,subject_wallet,status,title,reward_offer_pft,reward_actual_pft,last_event_tx_hash,last_event_cid,event_count,source)
    VALUES ($1,$2,$3,'rewarded','GUI join rewarded task',12.5,12.5,'tx_guijoin_r','cid_guijoin_r',2,'direct_write')`,
    [primaryTaskRewarded, primary, primaryWallet]);
  await query(`INSERT INTO task_events(id,task_id,account_id,wallet_address,event_type,source_tx_hash,source_cid)
    VALUES ($1,$1,$2,$3,'pf.reward.v1','tx_guijoin_r','cid_guijoin_r')`,
    [primaryTaskRewarded, primary, primaryWallet]);
  await query(`INSERT INTO task_projections(task_id,account_id,subject_wallet,status,title,reward_offer_pft,reward_actual_pft,last_event_tx_hash,last_event_cid,event_count,source)
    VALUES ($1,$2,$3,'rewarded','GUI join control task',7,7,'tx_guijoin_c','cid_guijoin_c',2,'direct_write')`,
    [controlTaskRewarded, control, controlWallet]);
  await query(`INSERT INTO task_events(id,task_id,account_id,wallet_address,event_type,source_tx_hash,source_cid)
    VALUES ($1,$1,$2,$3,'pf.reward.v1','tx_guijoin_c','cid_guijoin_c')`,
    [controlTaskRewarded, control, controlWallet]);

  // ----------------------------------------------------------------- payments
  // Daily airdrop run + submitted issuance per identity (the Profile payments surface).
  for (const [accountId, runTableId, recipient, amount, date] of [
    [primary, airdropRun, primaryWallet, 25, "2026-11-09"],
    [control, controlAirdropRun, controlWallet, 40, "2026-11-09"],
  ]) {
    await query(`INSERT INTO profile_daily_airdrop_runs (id, account_id, run_date, run_mode, is_canonical, status,
        daily_airdrop_pft, retention_value_score, what_raised_today, input_hash, input_snapshot, provider, model, prompt_version, prompt_digest, completed_at)
      VALUES ($1, $2, $3::date, 'production', true, 'completed', $4, 90, 'gui join fixture', 'sha256:gui-join', '{}'::jsonb, 'fixture', 'fixture', 'daily_airdrop_v1', 'sha256:prompt', now())`,
      [runTableId, accountId, date, amount]);
    await query(`INSERT INTO profile_daily_airdrop_issuances (id, account_id, run_id, run_date, source_wallet, recipient_wallet,
        amount_pft, amount_drops, status, source_cid, signed_tx_hash, attempt_count, submission_attempted_at, submitted_at, updated_at)
      VALUES ($1, $2, $3, $4::date, 'rHotWalletFixture', $5, $6, $7, 'submitted', 'cid_guijoin', 'tx_guijoin_airdrop', 1, now(), now(), now())`,
      [`airdrop_issue_${runTableId}`, accountId, runTableId, date, recipient, amount, String(amount * 1_000_000)]);
  }

  // --------------------------------------------------------------- initiatives
  // Two active initiatives; the primary identity's wallet contributes to one, control to the other.
  for (const [projectId, title, contributorWallet] of [
    [initiative, "GUI join initiative (primary)", primaryWallet],
    [controlInitiative, "GUI join initiative (control)", controlWallet],
  ]) {
    await query(`INSERT INTO network_projects (id, title, summary, status, priority, origin)
      VALUES ($1, $2, 'Fixture initiative for the GUI identity join regression', 'active', 5, 'gui_join_fixture')`,
      [projectId, title]);
    await query(`INSERT INTO network_project_contributors (project_id, wallet_address, codename, role_label, status, sort_order)
      VALUES ($1, $2, $3, 'Operator', 'active', 1)`,
      [projectId, contributorWallet, contributorWallet]);
  }

  // ----------------------------------------------- Finance Hub models + GoodBrief
  // Publish an encrypted ga-models bundle fixture through the same writer the production
  // publisher uses (tier: validator), containing the hub page, a company-model page and the
  // GoodBrief macro page.
  const files = {
    "index.html": Buffer.from("<html>Finance Hub fixture home</html>").toString("base64"),
    "models/rklb.html": Buffer.from("<html>RKLB company model fixture</html>").toString("base64"),
    "macro/goodbrief.html": Buffer.from("<html>GoodBrief macro fixture</html>").toString("base64"),
  };
  const contentKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", contentKey, iv);
  const encrypted = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify({ version: 1, files })))), cipher.final()]);
  const bundleBytes = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  const contentHash = createHash("sha256").update(bundleBytes).digest("hex");
  await upsertIndex({
    indexId: "ga-models",
    title: "Finance Hub (gui-join fixture)",
    summary: "gui-join fixture",
    tier: "validator",
    contentKey: contentKey.toString("base64"),
    contentHash,
    contentUrl: "/api/index-viewer/indices/ga-models/content",
    metadata: { format: "tasknode-encrypted-static-v1", viewerUrl: "/api/research/bundles/ga-models/index.html" },
  });
  await query(`INSERT INTO index_viewer_bundles(index_id, encrypted_bytes) VALUES ('ga-models', $1)
    ON CONFLICT (index_id) DO UPDATE SET encrypted_bytes = EXCLUDED.encrypted_bytes, updated_at = now()`, [bundleBytes]);

  // ================================================================= assertions
  const sessionPrimary = { id: `sess_guijoin_primary_${runId}`, accountId: primary, displayName: "GUI Join Primary", hiveHandle: "gui_join_primary" };
  const sessionControl = { id: `sess_guijoin_control_${runId}`, accountId: control, displayName: "GUI Join Control", hiveHandle: "gui_join_control" };

  // 1. The one-identity join the GUI boots from: /api/app-state for the primary session.
  const primaryState = await appState(sessionPrimary);
  assert.equal(primaryState.session.status, "signed_in");
  assert.equal(primaryState.session.accountId, primary);
  assert.equal(primaryState.session.displayName, "GUI Join Primary");
  assert.equal(primaryState.wallet.pftWallet.status, "linked");
  assert.equal(primaryState.wallet.pftWallet.address, primaryWallet, "payment wallet is the identity's own linked wallet");
  assert.ok(Array.isArray(primaryState.session.validator.bindings) && primaryState.session.validator.bindings.length === 1,
    "validator status is joined into the same session payload");
  assert.equal(primaryState.session.validator.bindings[0].network, "devnet");
  const taskIds = [
    ...primaryState.tasks.outstanding.map((task) => task.taskId),
    ...primaryState.tasks.rewarded.map((task) => task.taskId),
  ];
  assert.ok(taskIds.includes(primaryTaskOutstanding), "the identity's outstanding task is exposed");
  assert.ok(taskIds.includes(primaryTaskRewarded), "the identity's rewarded task is exposed");
  assert.equal(taskIds.includes(controlTaskRewarded), false, "another identity's task never appears");
  const serializedPrimary = JSON.stringify(primaryState);
  for (const controlIdentifier of [control, controlWallet, controlTaskRewarded]) {
    assert.equal(serializedPrimary.includes(controlIdentifier), false, `app-state must not leak ${controlIdentifier}`);
  }

  // The control identity sees only its own task and no validator binding.
  const controlState = await appState(sessionControl);
  assert.equal(controlState.session.accountId, control);
  assert.equal(controlState.wallet.pftWallet.address, controlWallet);
  assert.deepEqual(controlState.session.validator.bindings, []);
  const controlTaskIds = [...controlState.tasks.outstanding, ...controlState.tasks.rewarded].map((task) => task.taskId);
  assert.ok(controlTaskIds.includes(controlTaskRewarded));
  assert.equal(controlTaskIds.includes(primaryTaskRewarded), false);
  assert.equal(JSON.stringify(controlState).includes(primary), false, "control app-state must not leak the primary identity");

  // 2. Validator status route for the same identity.
  const validatorDashboard = await getRoute(handleValidatorResearchRoute, "/api/validators", sessionPrimary);
  assert.equal(validatorDashboard.status, 200);
  assert.equal(validatorDashboard.body.ok, true);
  assert.equal(validatorDashboard.body.bindings.length, 1);
  assert.equal(validatorDashboard.body.bindings[0].master_public_key, masterPublicKey);
  assert.equal(validatorDashboard.body.bindings[0].network, "devnet");
  assert.equal(JSON.stringify(validatorDashboard.body).includes(control), false);
  assert.equal((await getRoute(handleValidatorResearchRoute, "/api/validators", null)).status, 401, "validator status requires the signed-in identity");

  // 3. Models + GoodBrief (Finance Hub bundle) for the same identity, through the real
  // tier-gated bundle route the GUI iframe loads.
  const hub = await bundleRoute(FINANCE_HUB_BUNDLE_PATH, sessionPrimary);
  assert.equal(hub.status, 200);
  assert.equal(hub.headers["content-type"], "text/html; charset=utf-8");
  assert.ok(hub.body.toString().includes("Finance Hub fixture home"));
  const modelPage = await bundleRoute("/api/research/bundles/ga-models/models/rklb.html", sessionPrimary);
  assert.equal(modelPage.status, 200);
  assert.ok(modelPage.body.toString().includes("RKLB company model fixture"));
  const goodBrief = await bundleRoute("/api/research/bundles/ga-models/macro/goodbrief.html", sessionPrimary);
  assert.equal(goodBrief.status, 200);
  assert.ok(goodBrief.body.toString().includes("GoodBrief macro fixture"));
  assert.equal((await bundleRoute(FINANCE_HUB_BUNDLE_PATH, sessionControl)).status, 403,
    "an identity without a validator binding is refused the Finance Hub");
  assert.equal((await bundleRoute(FINANCE_HUB_BUNDLE_PATH, null)).body.error, "not_signed_in");

  // 4. The GUI client gates the Finance Hub on the same session payload the server produced.
  assert.equal(hasFinanceHubAccess(primaryState.session), true, "GUI offers models/GoodBrief to the bound identity");
  assert.equal(hasFinanceHubAccess(controlState.session), false, "GUI hides models/GoodBrief from the unbound identity");
  assert.equal(hasFinanceHubAccess(null), false);
  assert.ok(financeHubFrameSrc({ model: "RKLB", tab: "summary" }, "dark").startsWith(FINANCE_HUB_BUNDLE_PATH));
  assert.equal(validatorMenuStatus(primaryState.session.validator.bindings).length > 0, true,
    "GUI validator chip renders the identity's binding");
  assert.match(validatorTooltip(primaryState.session.validator.bindings), /devnet/i);

  // 5. Initiatives (Hive projects) for the same identity, with its own wallet joined as contributor.
  const hive = await getRoute(handleHiveRoute, "/api/hive/projects", sessionPrimary, { getLinkedWallet, readJson: async () => ({}) });
  assert.equal(hive.status, 200);
  assert.equal(hive.body.ok, true);
  assert.ok(Array.isArray(hive.body.document.projectIds) && hive.body.document.projectIds.includes(initiative),
    "the initiative is exposed on the Hive surface");
  const initiativeDocument = hive.body.document.projects[initiative];
  assert.ok(initiativeDocument, "initiative document is present");
  assert.ok(
    JSON.stringify(initiativeDocument).includes(primaryWallet),
    "the identity's wallet is joined into its initiative membership",
  );
  assert.ok(hive.body.document.projectIds.includes(controlInitiative), "the shared board lists the other initiative");
  assert.equal((await getRoute(handleHiveRoute, "/api/hive/projects", null, { getLinkedWallet, readJson: async () => ({}) })).status, 200,
    "signed-out visitors still get the board, without a viewer context");

  // 6. Payments for the same identity: reward history (task payments) and the daily airdrop.
  const rewardHistory = await getRoute(handleProfileRoute, "/api/profile/reward-history", sessionPrimary);
  assert.equal(rewardHistory.status, 200);
  assert.equal(rewardHistory.body.ok, true);
  const rewardTotal = Number(rewardHistory.body.history?.totals?.rewardPft ?? rewardHistory.body.history?.totalRewardPft ?? NaN);
  assert.ok(Number.isFinite(rewardTotal) && rewardTotal > 0, "reward history reports the identity's task payments");
  const serializedHistory = JSON.stringify(rewardHistory.body);
  assert.equal(serializedHistory.includes(primaryTaskRewarded) || rewardTotal >= 12.5, true);
  assert.equal(serializedHistory.includes(controlTaskRewarded), false, "no other identity's payments leak");
  assert.equal((await getRoute(handleProfileRoute, "/api/profile/reward-history", null)).status, 401);

  const airdrop = await getRoute(handleProfileRoute, "/api/profile/daily-airdrop", sessionPrimary);
  assert.equal(airdrop.status, 200);
  assert.equal(airdrop.body.ok, true);
  assert.equal(airdrop.body.latest.id, airdropRun);
  assert.equal(Number(airdrop.body.latest.issuance.amountPft), 25);
  assert.equal(airdrop.body.latest.issuance.recipientWallet, primaryWallet);
  assert.equal(JSON.stringify(airdrop.body).includes(controlAirdropRun), false);
  const controlAirdrop = await getRoute(handleProfileRoute, "/api/profile/daily-airdrop", sessionControl);
  assert.equal(controlAirdrop.body.latest.id, controlAirdropRun, "each identity reads only its own airdrop");
  assert.equal((await getRoute(handleProfileRoute, "/api/profile/daily-airdrop", null)).status, 401);

  console.log("gui-identity-join ok: one identity's session payload joins tasks, its linked payment wallet, rewarded-task history, daily airdrop, validator status, validator-gated Finance Hub models + GoodBrief and its Hive initiative; a control identity leaks into none of them");
} finally {
  await query(`DELETE FROM network_project_contributors WHERE project_id = ANY($1::text[])`, [[initiative, controlInitiative]]).catch(() => {});
  await query(`DELETE FROM network_projects WHERE id = ANY($1::text[])`, [[initiative, controlInitiative]]).catch(() => {});
  await query(`DELETE FROM profile_daily_airdrop_issuances WHERE account_id = ANY($1::text[])`, [[primary, control]]).catch(() => {});
  await query(`DELETE FROM profile_daily_airdrop_runs WHERE account_id = ANY($1::text[])`, [[primary, control]]).catch(() => {});
  await query(`DELETE FROM task_events WHERE account_id = ANY($1::text[])`, [[primary, control]]).catch(() => {});
  await query(`DELETE FROM task_projections WHERE account_id = ANY($1::text[])`, [[primary, control]]).catch(() => {});
  await query(`DELETE FROM validator_bindings WHERE account_id = ANY($1::text[])`, [[primary, control]]).catch(() => {});
  await query(`DELETE FROM validator_challenges WHERE account_id = ANY($1::text[])`, [[primary, control]]).catch(() => {});
  await query(`DELETE FROM account_linked_wallets WHERE account_id = ANY($1::text[])`, [[primary, control]]).catch(() => {});
  await query(`DELETE FROM index_viewer_bundles WHERE index_id = 'ga-models'`).catch(() => {});
  await query(`DELETE FROM index_viewer_indices WHERE index_id = 'ga-models'`).catch(() => {});
  await closePool().catch(() => {});
}
