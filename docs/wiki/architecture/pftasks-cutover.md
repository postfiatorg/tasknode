# PFTasks Cutover

This runbook moves a user from the old PFTasks app into Task Node Official without losing custody boundaries or leaving both apps able to issue work for the same wallet.

The product-level cutover executed on 2026-06-10: `https://tasknode.postfiat.org` serves Task Node Official and old PFTasks task-side authority is shut down (see the [Production Cutover Execution Checklist](#docs/task-node-production-cutover-execution-checklist)). This page remains the per-account migration procedure for moving an individual user's wallet, context, and NFT state.

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

Prefer chain inventory for the canonical import path:

```bash
npm run wallet-nft-inventory -- --wallet r... --pretty --no-metadata

npm run wallet-nft-inventory -- \
  --wallet r... \
  --account-id acct_oauth_... \
  --import-profile-cache \
  --timeout-ms 3000 \
  --metadata-concurrency 6 \
  --execute
```

That command queries PFTL `account_nfts`, decodes each on-chain NFT metadata URI, fetches IPFS metadata, extracts the image CID, and upserts renderable `profile_nfts` cache rows. It does not depend on the old PFTasks database.

Use `npm run profile-nft-import-pftasks` only as a historical bootstrap or audit shortcut. It accepts old PFTasks `nft_mints` rows as JSON, filters to `status = 'minted'` and the requested owner wallet, then upserts Task Node Official `profile_nfts` rows with stable ids of the form `nft_pftasks_<old_mint_id>`. The import is cache-only: it does not move NFTs, sign transactions, change custody, or alter the old PFTasks rows.

Example operator flow:

```bash
# 1. Query old PFTasks nft_mints for the wallet from the old PFTasks API app.
# 2. Dry-run the import against Task Node Official.
npm run profile-nft-import-pftasks -- \
  --account-id acct_oauth_... \
  --wallet r... \
  --source-json /tmp/old-pftasks-nfts.json \
  --dry-run

# 3. Execute only after the dry run shows the expected minted rows.
npm run profile-nft-import-pftasks -- \
  --account-id acct_oauth_... \
  --wallet r... \
  --source-json /tmp/old-pftasks-nfts.json \
  --execute
```

Before deprecating old PFTasks IPFS gateways, run exact-CID repin over the full historical NFT set, not only one wallet. Export all minted old `nft_mints` rows with `image_cid`, `metadata_cid`, and `thumbnail_cid`, then classify and repin:

```bash
npm run --silent profile-nft-cid-repin -- \
  --source-json /tmp/pftasks-nft-mints-all.json \
  --dry-run \
  --limit 100

npm run --silent profile-nft-cid-repin -- \
  --source-json /tmp/pftasks-nft-mints-all.json \
  --execute \
  --limit 250 \
  --offset 0 \
  --no-verify-after

npm run --silent profile-nft-cid-repin -- \
  --source-json /tmp/pftasks-nft-mints-all.json \
  --verify-only
```

The cutover is not done while any CID remains `needs_repin`, `missing_from_legacy_gateways`, `repin_requested_not_yet_verified`, or `repin_failed`. Existing minted NFTs point at immutable CIDs. If a CID cannot be preserved through `pinByHash`, move the exact block from the old IPFS node into current infrastructure or keep the legacy gateway available for that exception until a deliberate remint/migration path exists.

For large migrations, repeat the execute command with `--offset` increased by the batch size until the dry-run `uniqueCids` count is covered. Do not run a full unbounded execute in an interactive shell unless the process is deliberately supervised and its JSON report is redirected to a file.

### June 6, 2026 PFTasks NFT Repin Run

The historical PFTasks export contained 3,388 minted NFT rows across 56 users and 57 wallets. Those rows deduped to 10,065 public NFT CIDs: 3,355 image CIDs, 3,355 metadata CIDs, and 3,355 thumbnail CIDs.

The first full execute pass covered all 10,065 CIDs. 9,016 already resolved from current gateways and 1,049 were accepted by Pinata as exact-CID `pinByHash` requests. No CID was missing from the old PFTasks gateways and no Pinata request failed.

The follow-up verify and retry passes reduced the legacy-only tail to one thumbnail CID: `bafkreicmubbbsmf4arvxj35ia3f3mdesry52mjpq4ie45de73vz3mvorqe`. That CID exists on the old IPFS node, was pinned and announced there, and has an open Pinata `prechecking` job. Keep old PFTasks gateways configured as fallback until that final CID resolves from current infrastructure or is moved by another exact-CID block transfer.

Live gateway order should prefer current infrastructure first, with old PFTasks gateways last:

```text
https://gateway.pinata.cloud/ipfs/,
https://dweb.link/ipfs/,
https://ipfs.io/ipfs/,
https://ipfs-testnet.postfiat.org/ipfs/,
https://pft-ipfs-testnet-node-1.fly.dev/ipfs/
```

After import, the current Task Node Official profile NFT gallery can render those IPFS image CIDs because `/api/profile/nfts`, public profile, Hive, and recommended-connections avatars all read current-wallet `profile_nfts` cache rows.

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
