# Data Recovery

Task Node uses forward-only, transactional SQL migrations. Application rollback
normally deploys the previous compatible image; database rollback restores a
pre-migration backup into a new database after an incompatible or destructive
change. Reverse SQL is not improvised during an incident.

## Public recovery boundary

The repository ships a loopback-only recovery tool. It deliberately refuses
remote databases and restores only into a new database whose name begins with
`tasknode_recovery_`. It never drops an operator-selected database. Official
production backup storage, encryption keys, schedules, approvals, and target
credentials belong in the private operations package.

Create and integrity-check a local Postgres custom-format backup plus the
legacy runtime-store snapshot:

```bash
node scripts/data-recovery.mjs backup \
  --database-url postgres://tasknodeofficial:tasknodeofficial@127.0.0.1:5436/tasknodeofficial \
  --runtime-store /path/to/runtime-store.json \
  --output /path/to/new-empty-backup-directory
```

Restore is permitted only into an empty loopback database with the recovery
prefix. The runtime-store target must not already exist:

```bash
node scripts/data-recovery.mjs restore \
  --database-url postgres://tasknodeofficial:tasknodeofficial@127.0.0.1:5436/tasknode_recovery_manual \
  --backup /path/to/backup \
  --runtime-target /path/to/new-runtime-store.json
```

## Automated drill

`npm run data-recovery-drill` creates two randomly named disposable databases,
applies every migration, inserts synthetic sentinels, backs up both state
stores, simulates a destructive deployment, restores into the second database,
and verifies:

- Postgres and runtime-store sentinels survive restore;
- post-backup mutations do not leak into restored state;
- the complete migration set is present and idempotent;
- a deliberately failing migration transaction leaves neither schema nor
  migration-ledger residue; and
- every temporary database and plaintext drill artifact is removed afterward.

Run it against a disposable local pgvector/Postgres administrator:

```bash
TASKNODE_RECOVERY_ADMIN_URL=postgres://tasknodeofficial:tasknodeofficial@127.0.0.1:5436/postgres \
  npm run data-recovery-drill
```

Production release evidence must additionally identify the encrypted backup
provider, retention policy, restore target fingerprint, drill timestamp,
recovery-time result, recovery-point result, and two approving operators. The
public tool is evidence that the application data can round-trip; it is not a
substitute for production operations evidence.
