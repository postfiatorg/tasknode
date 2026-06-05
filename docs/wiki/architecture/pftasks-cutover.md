# PFTasks Cutover

This runbook moves a user from the old PFTasks app into Task Node Official without losing custody boundaries or leaving both apps able to issue work for the same wallet.

The rule is simple: first make the old app stop acting for the wallet, then link or restore the wallet in the new app, then import only the state that Task Node Official can actually use.

## Scope

Use this for an account-level PFTasks to Task Node Official migration.

The old PFTasks app owns old database rows for users, tasks, profile settings, old chat history, old context CIDs, old wallet sync targets, and old NFT cache rows.

Task Node Official owns the new account, billing, chat, memory, current context draft, profile NFTs, recommended connections, PFTL task projections, and Hive routing.

PFT and NFT ownership remain wallet-owned on-chain. The cutover does not move coins, seeds, or NFTs. The user keeps the wallet only if they still control the seed or can sign a wallet proof in the new app.

## N=1 Preflight

Run old PFTasks inventory read-only first.

```bash
cd /home/pfrpc/repos/pftasks
CUTOVER_WALLET=rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx \
node - <<'NODE'
const fs = require('fs');
const { Client } = require('./api/node_modules/pg');
const wallet = process.env.CUTOVER_WALLET;
if (!wallet) throw new Error('CUTOVER_WALLET required');
for (const line of fs.readFileSync('api/.env', 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const client = new Client({ connectionString: process.env.DATABASE_READONLY || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const q = (sql, params = []) => client.query(sql, params).then((r) => r.rows);
(async () => {
  await client.connect();
  await client.query('BEGIN TRANSACTION READ ONLY');
  const wallets = await q(`
    SELECT u.id AS user_id, u.status AS user_status, uw.id AS wallet_id,
           uw.wallet_address, uw.is_active, uw.is_primary, uw.is_public,
           uw.deactivated_at, uw.context_doc_cid, uw.context_version
    FROM user_wallets uw
    JOIN users u ON u.id = uw.user_id
    WHERE uw.wallet_address = $1
  `, [wallet]);
  const userIds = wallets.map((row) => row.user_id);
  const walletIds = wallets.map((row) => row.wallet_id);
  console.log(JSON.stringify({
    wallets,
    openTasks: userIds.length ? await q(`
      SELECT id, wallet_id, status, task_category, title, created_at, accepted_at
      FROM tasks
      WHERE user_id = ANY($1::uuid[])
        AND status = ANY($2::text[])
      ORDER BY created_at DESC
    `, [userIds, ['pending', 'accepted', 'in_progress', 'submitted', 'pending_verification', 'overdue']]) : [],
    contextRevisions: userIds.length ? await q(`
      SELECT count(*)::int AS count, max(created_at) AS latest_created_at
      FROM context_revisions
      WHERE user_id = ANY($1::uuid[])
    `, [userIds]) : [],
    nftMints: userIds.length ? await q(`
      SELECT status, count(*)::int AS count, max(created_at) AS latest_created_at, max(minted_at) AS latest_minted_at
      FROM nft_mints
      WHERE user_id = ANY($1::uuid[]) OR wallet_address = $2 OR owner_wallet_address = $2
      GROUP BY status
      ORDER BY status
    `, [userIds, wallet]) : [],
    activeSyncTargets: await q(`
      SELECT wallet_address, owner_wallet_address, status
      FROM wallet_sync_targets
      WHERE (wallet_address = $1 OR owner_wallet_address = $1)
        AND status = 'active'
      ORDER BY priority, wallet_address
    `, [wallet]),
    activeRiskChecks: walletIds.length ? {
      activeNftOffers: await q(`
        SELECT count(*)::int AS count
        FROM nft_transfer_offers
        WHERE status = ANY($2::text[])
          AND (
            (seller_wallet_address = $1 AND NOT (source = 'external' AND (destination_wallet_address IS NULL OR btrim(destination_wallet_address) = '')))
            OR (destination_wallet_address = $1 AND source <> 'external')
          )
      `, [wallet, ['pending_create', 'open', 'pending_accept', 'pending_cancel', 'external_open']]),
      airdropsInProgress: await q(`
        SELECT count(*)::int AS count
        FROM daily_airdrop_issuances
        WHERE wallet_id = ANY($1::uuid[])
          AND status = 'processing'
      `, [walletIds]),
      rewardPayoutsInProgress: await q(`
        SELECT count(*)::int AS count
        FROM task_submissions s
        JOIN tasks t ON t.id = s.task_id
        WHERE t.wallet_id = ANY($1::uuid[])
          AND s.reward_status = ANY($2::text[])
      `, [walletIds, ['paying', 'scoring', 'scored']]),
    } : {},
  }, null, 2));
  await client.query('ROLLBACK');
  await client.end();
})().catch(async (error) => {
  try { await client.query('ROLLBACK'); await client.end(); } catch {}
  console.error(error.message);
  process.exit(1);
});
NODE
```

Run Task Node Official inventory from the Fly app machine, because the new app still keeps auth and linked-wallet state in the runtime store.

```bash
cd /home/pfrpc/repos/tasknodeofficial
fly ssh console -a tasknodeofficial-dev --process-group app -C \
  "sh -lc 'cd /app && node scripts/query-user-tasks.mjs --handle goodalexander'"
```

For a fuller cutover inventory, check the account's linked wallet, current context document, context history pointers, task projections, profile NFTs, and `pftl_sync_wallets`.

## Old PFTasks Shutdown

Do not delete old rows during the first cutover. Preserve old rows as audit history and make them inert.

For an account-level shutdown:

1. Confirm no active NFT offers, reward payout, or daily airdrop is in progress.
2. Cancel every old non-terminal task for the user with cancellation reason `pftasks_cutover_to_tasknodeofficial`.
3. Insert `task_cancelled` events for the cancelled tasks.
4. Cancel pending or running old worker jobs for the user or wallet.
5. Set every old wallet row for the user to inactive, not primary, not public, and deactivated.
6. Set old `wallet_sync_targets.status = 'inactive'` where the wallet is either `wallet_address` or `owner_wallet_address`.
7. Disable old Discord chat wallet links.
8. Unpublish old PFTasks profile settings.
9. Mark the old user `status = 'deleted'` and increment `auth_token_version` so existing old PFTasks sessions fail.
10. Insert an `audit_log` row recording the target wallet, user id, cancelled tasks, and cutover reason.

The `deleted` status is intentional for old PFTasks. Old auth code blocks deleted users and refuses to reactivate them through OAuth. A softer custom status is not enough because old OAuth paths set any non-deleted user back to `active`.

## New App Port

The new app cannot silently take custody of the old wallet. The user must link or restore the old wallet in Task Node Official by signing a wallet proof from the browser. If the old wallet is not linked, Task Node Official can still keep the new account running on its current linked wallet, but old wallet history will not automatically become the active task wallet.

Context has two paths:

- Current context draft is account-scoped in Task Node Official. Import the old current context only after the user has selected the old context version they want to restore.
- Historical context pointers are wallet-scoped. After the old wallet is linked and synced, the Context page can show old encrypted context CIDs and the browser can decrypt previews with the local wallet vault.

NFTs have two paths:

- Minted NFTs remain on-chain with the old wallet. They do not move during cutover.
- Task Node Official profile NFT rows can be imported from old `nft_mints` metadata only as cache records. The on-chain token id, mint tx hash, metadata CID, image CID, owner wallet, and mint status must be preserved.

Old PFTasks tasks should not be imported as live new Task Node tasks. Treat them as historical evidence unless a separate replay importer proves that the old event stream maps cleanly into Task Node Official `task_projections`.

## URL Cutover

Do not redirect old PFTasks until the n=1 account works in the new app.

When ready:

1. Put old PFTasks in read-only or blocked mode.
2. Stop old worker/task processors.
3. Verify Task Node Official `app`, `worker`, and `board-manager` Fly process groups are running.
4. Update Task Node Official public URL settings and OAuth callback domains.
5. Redirect the old URL to the new app with clear deprecation copy.
6. Keep the old database available for audit and rollback inspection.

## Rollback

Rollback is possible only if old rows were preserved.

To roll back an account-level cutover, restore the old `users.status`, restore old wallet active flags, restore required `wallet_sync_targets`, and clear the old task cancellation only for tasks that were cancelled by the cutover transaction. Do not roll back chain transactions, reward payouts, minted NFTs, or Task Node Official rows by hand.
