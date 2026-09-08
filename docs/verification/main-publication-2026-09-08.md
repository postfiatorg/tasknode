# Task Node main publication — September 8, 2026

The repository operator explicitly instructed publishing all local Task Node
work to `main`. The local snapshot `a6251af` preserves 663 changed files and the
previous local commits, including Corbanu account selection and validator work
evidence. It was reconciled with remote main `d0d1604`, preserving the merged
Hive group and Docs conversation-history work.

The published source includes the Hyperstitional Ink / Techno Mordor NFT
prompts, art pipeline, provider migration, Campaign Tracker, request/reward
recovery, board operator work, document improvements, dark mode and accumulated
verification records. Local credentials and ignored runtime stores remain
outside Git. This is source publication; it does not perform a new deployment.

## Merge verification

Twenty merge conflicts were reconciled. The current model routing and NFT image
viewer were retained; upstream's Hive status hook and portable browser fixture
were integrated with the local theme. A duplicate worker import introduced by
the automatic merge was removed. The API reference was regenerated for 174
route policies.

The existing Campaign Tracker outer request contract accepted undeclared fields
before its command-specific validation. The shared envelope now declares the
supported fields, while the handler retains required-field, nested-data and
account authorization checks. A regression exercises eight command envelopes
and rejects three kinds of undeclared fields for each; it is included in the
unit-test command.

All seven repository checks passed: format, lint, public Help boundary, API
reference, source-file size, frontend build and bundle budget. Twelve focused
checks passed for Corbanu account selection, NFT art/prompt contracts, inference
failover/no-regex enforcement, chat model selection, request validation,
Campaign Tracker model/body contracts, retired task loops and theme state.

Full database/browser/product end-to-end qualification was not repeated for
this source reconciliation. An attempted board fixture lacked its dedicated
database; an attempted standalone-theme fixture lacked its browser process.
Those attempts are not represented as passes. Existing feature-specific
verification records accompany the source. GitHub CI runs on the resulting main
commit.

## CSS budget

The accepted full-surface theme increases the built application CSS to 211,918
bytes, or 33,383 bytes gzipped. The previous limits were 175,000 / 30,000 bytes.
The application-CSS budget is now 220,000 / 35,000 bytes to include that feature;
all other bundle limits are unchanged. This is a disclosed budget increase,
not a claim of reduced bundle size.

## Credential review

The complete index snapshot was scanned, including verification artifacts.
No exact matches were found against 21 locally available credential values
across 1,628 files. The stricter detector flagged 39 source-file SHA256 values
in two provenance manifests; each was reviewed as a checksum. The unpublished
commit-range scan passed with no detected credentials. Raw local scan logs and
merge inventories are retained privately under the mounted scratch volume.
