# Task Node Privacy Notice

Effective: 2026-08-15

This notice describes the Task Node application's implemented data flows. A
self-hosted fork is controlled by its operator and must publish its own notice.

## Data Task Node processes

- **Account and identity:** account ID, connected login-provider identifiers,
  public profile fields, Task Node handle, session and OAuth state, and account
  security/audit events.
- **Wallet and protocol:** public addresses and keys, signed ownership proofs,
  signed transactions submitted through the service, balances, deposits, task
  and reward projections, and public-chain pointers. Task Node is designed not
  to receive wallet recovery phrases or private signing keys.
- **AI Chat:** plaintext user and assistant messages, attachments, conversation
  metadata, selected mode/persona, usage and billing records, and derived
  context or memory needed to provide the service.
- **Context, tasks, profiles, Hive, and Docs:** content and metadata users
  create, share, submit, or publish; access grants; encrypted payload pointers;
  profile images/NFT metadata; and verification records.
- **Product and security telemetry:** request/session metadata, errors, feature
  events, and configured analytics. Session replay is disabled in the official
  configuration reviewed with this notice.

## AI providers and other systems

Configured inference providers receive the request packet needed to answer AI
Chat or run an enabled worker. Analytics providers receive configured product
events. Login providers process their own authentication data. Postgres and
the service's infrastructure providers store application data.

PFDocs is a separate stateful document service. PFTL and IPFS may retain public
pointers or encrypted payloads. Public-chain facts remain public and cannot be
erased by deleting a Task Node account.

## Private Messages

More -> Messages is not AI Chat. The browser derives a Nostr key while the
wallet is unlocked, encrypts message text using NIP-17/NIP-44, and connects
directly to configured independent relays. Task Node stores the public Nostr
key, handle/NIP-05 binding, preferred relays, wallet proof, and visibility—not
the message body or private Nostr key. Relays retain encrypted gift wraps under
their own policies and can observe connection and ciphertext metadata.

## Purposes and choices

Task Node uses data to authenticate users, provide requested features, perform
wallet and task operations, prevent abuse, calculate usage/rewards, maintain
security, and improve reliability. Public profile visibility, connected
accounts, Nostr activation, wallet signing, and sharing actions are controlled
through the applicable product flow.

Do not place secrets, regulated personal data, or another person's private data
in AI prompts, task evidence, public profiles, public-chain memos, or public
issues.

## Retention, export, and deletion

The authoritative retention schedule is `docs/data-retention.md`. Account
deletion removes or de-identifies account-scoped server data and revokes active
sessions and bindings, subject to narrowly retained security, financial, and
public-chain records. It cannot remove independently retained relay, IPFS,
provider, recipient, or blockchain copies.

Use Settings -> Data controls for account deletion. Use the official Post Fiat
community contact at <https://postfiat.org/community/> for privacy access or
correction requests that cannot be completed in the app.

## Changes

Material changes will update the effective date and be published with the
service. The exact deployed policy and controlling operator govern the hosted
service; this repository copy documents the corresponding source release.
