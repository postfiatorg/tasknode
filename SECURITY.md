# Security Policy

## Supported versions

Security fixes are applied to the current protected default branch and the
currently deployed production release. Historical snapshots and unmaintained
forks are not supported.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's
**Security -> Report a vulnerability** flow for this repository. Include:

- the affected commit or production URL;
- a minimal reproduction and expected impact;
- whether user data, wallet signing, authentication, billing, rewards, or
  privileged workers are involved; and
- any temporary mitigation already applied.

Do not access another person's account, extract production data, move funds,
degrade the service, or retain more data than is necessary to demonstrate the
issue. Use local synthetic data whenever possible.

## Response expectations

The maintainers will acknowledge a complete report within three business days,
assign a severity and owner, and coordinate remediation and disclosure with the
reporter. Acknowledgement is not a promise of a bounty. Critical issues may
require immediate credential rotation, feature isolation, or deployment
rollback before a full explanation is published.

## Security boundaries

- Wallet recovery phrases and private signing keys are intended to remain in
  the browser. A report showing server receipt or logging of either is critical.
- AI Chat is server-persisted and provider-processed; it is not end-to-end
  encrypted.
- More -> Messages uses browser-side NIP-17 encryption and independent Nostr
  relays. Task Node stores the public identity binding, not message bodies.
- Public-chain records and independent relay copies cannot be removed by Task
  Node account deletion.

Operational runbooks, credentials, incident evidence, and production topology
belong in the private operations system, not public reports or issues.
