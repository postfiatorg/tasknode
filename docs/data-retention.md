# Data Retention and Deletion

Effective: 2026-08-15

This schedule describes the defaults enforced by Task Node source code. An
operator of a fork must publish its own schedule and configure infrastructure
backups and third-party processors consistently with it.

## Enforced schedule

| Data class | Active retention | After deletion or expiry | Default automated purge |
| --- | --- | --- | --- |
| AI Chat messages and attachments | Until the user deletes the conversation or account | A deleted conversation is hidden immediately | Message bodies, attachment text, derived conversation memory, model runs, and conversation metadata are deleted after 30 days |
| Context, profile, task, Hive, and recommendation content | Until the user deletes the account or the feature removes it | Account-scoped server copies are deleted during account deletion | Immediate account deletion; public-chain or deliberately published copies are outside Task Node's control |
| Provider-call diagnostics and completed memory jobs | Needed for delivery and short-term reliability investigation | No user-facing archive | 30 days |
| Telegram bot event records | Needed for delivery and troubleshooting | No user-facing archive | 30 days |
| Product/security observability | While needed for security and reliability | Uses a record-specific `retention_until` when present | Otherwise 90 days |
| Collaboration audit events | Needed to investigate access grants and document/team actions | Pseudonymous records may outlive active collaboration data | 365 days |
| Web/terminal sessions, OAuth state, email codes, wallet challenges, and terminal handoffs | Only through their configured expiry | Revoked, consumed, replaced, or expired records are unusable immediately; bearer and challenge lookup values are stored as SHA-256 hashes | Purged after expiry or seven days after terminal state is consumed/revoked |
| Ethereum deposit assignments and balance checkpoints | While the account and its financial integrity records are active | Deleted with account-scoped application data; allocator indexes are never rolled backward or reassigned | Account deletion plus the bounded financial-record schedule |
| Nostr identity binding | Until the user revokes Messages, hides the profile, or deletes the account | Task Node deletes the binding; relays remain independent | Immediate on revoke/account deletion |
| API rate-limit buckets | Through the abuse-control window | Only a SHA-256 bucket identifier is stored | Two days after reset |
| Billing, initiation-grant, and account-deletion fraud records | While required for financial integrity and repeat-grant prevention | Account content and free-form metadata are removed; the account key and identity inputs are pseudonymized | Seven years, configurable only within bounded limits |
| Public blockchain, IPFS, recipients, Nostr relays, login providers, and inference providers | Controlled by those independent systems | Task Node cannot erase independent copies | Their policies and protocol behavior apply |

The production retention worker is enabled by default and runs every six hours.
`server/data-retention.js` owns the bounded configuration and purge transaction.
A failed purge is logged and retried; it is never reported as successful.

## Export

Signed-in users can select **Settings -> Data controls -> Export data**. The
authenticated `GET /api/account/export` response downloads a JSON snapshot of
the user's runtime account state and every Postgres row scoped to that account.
The export does not contain another account's rows, server credentials, session
cookies, OAuth authorization codes, wallet recovery phrases, or private wallet
keys.

## Account deletion

Account deletion is a confirmed, authenticated transaction. It:

1. records a narrow pseudonymous deletion/fraud record;
2. deletes every non-retained Postgres row with the account ID, including
   plaintext chats, attachments, memory, context, profiles, Nostr bindings,
   collaboration data, tasks, analytics, and worker artifacts;
3. removes runtime account, login, session, conversation, context, and identity
   state;
4. strips free-form text and linkage metadata from retained billing and grant
   records and replaces the account ID with a deletion archive ID; and
5. expires the browser session.

The narrow deletion audit stores hashes, deletion time, a fixed reason code,
and the archive ID. It does not retain the raw account ID, email, wallet,
provider user ID, session token, display name, username, or a user-supplied
reason. A public-chain transaction or independently delivered message cannot be
recalled by this process.

## Backups and restores

Backups must not become an indefinite deletion bypass. Production operations
must encrypt backups, restrict restore authority, expire backup generations no
later than 35 days unless a documented legal hold applies, and rerun deletion
and retention processing after a restore. The public source release is blocked
until the exact deployment has a successful backup/restore drill and evidence
that backup expiry matches this schedule.

The executable local recovery contract, safety guards, and migration rollback
drill are documented in [Data Recovery](./data-recovery.md).
