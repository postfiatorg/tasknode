# Vercel primary and Ambient backup verification

> Deployed to production on September 5, 2026 as Fly release **v700** after the
> user explicitly requested deployment. See `deployment-v700.json` for the image,
> all 10 active process groups, migration 132, public API checks, and successful
> primary/backup calls from the deployed code. The implementation-only notes
> below describe the state before that deployment.

Implemented in `/home/pfrpc/repos/tasknode` on September 5, 2026. The shared
adapter now selects Vercel first and Ambient second. GLM defaults resolve to
`zai/glm-5.3`; Instant and Team Context use `zai/glm-5.3-flash`. Help and existing
DeepSeek workers keep their model through Vercel. Current configuration and
limitations are documented in `docs/wiki/architecture/ai-providers.md`.

## Live boundary proof

`live-probes.json` records synthetic calls made with the deployed credentials.
The new local adapter was bundled into an ephemeral Node process over Fly SSH;
this did not deploy the application or change deployed files, secrets, or data.

- GLM 5.3: strict JSON schema with `xhigh` reasoning succeeded.
- GLM 5.3 Flash: streaming produced three text deltas and usage metadata.
- GLM 5.3 Flash: image input succeeded.
- GLM 5.3 research: server Exa search ran once and returned a citation URL;
  the reported aggregate cost and search count were parsed successfully.
- Injected Vercel HTTP 503: the new adapter completed through real Ambient
  `z-ai/glm-5.2`, recording both attempts and the actual backup model.
- Separate direct synthetic JSON probes also returned HTTP 200 for both Vercel
  models and Ambient GLM 5.2.

The local `.env.tasknodeofficial-dev` Vercel key returned HTTP 401. Its contents
were not modified. The deployed Vercel and Ambient credentials both worked.
Ambient's public catalogue lists GLM 5.2 ready, no GLM 5.3/Flash, and no ready
vision model. The configured Gemma vision backup remains capacity-dependent.

## Focused checks

Passed:

- `npm run inference-failover-smoke`: routing, provider failures, timeout before
  headers and during body reads, cancellation, SSE framing, partial-stream
  protection, search, images, usage, compatibility, concurrent requests, catalogue.
- `npm run inference-feature-smoke`: embedding golden compatibility, JSON parsing,
  privacy classifications and literals, image backup routing, search/cost metadata,
  unchanged user tariffs, structured action-quality decisions across adjacent cases.
- `npm run inference-no-regex-check`: 48 audited inference entry points/helpers.
- `npm run provider-egress-check`: 471 active source/config files, including operator shell scripts.
- Chat mode, spirit prompt, stream reliability, persona routing, attachments,
  agent chat origin, agent Hive chat, memory-worker request, and Telegram webhook smokes.
- Profile NFT prompt/flow, task evidence file processing, Hive project planning,
  Board Manager, secretary packet, expert badge, and Deathmarch smokes.
- `npm run team-context-smoke` against a newly created empty local fixture database.
- `npm run inference-persistence-smoke` against that fixture database: completed
  airdrop/public profile records retain the actual backup provider/model; migration
  132 supplies Vercel defaults and narrator provider attribution.
- Migration registration, System Status, lint, build, public Help boundary,
  formatting, and `git diff --check`.
- Board Manager operator help commands and Deathmarch help/fixture execution.
- Reward environment generation in a temporary directory: both provider keys were
  copied from synthetic fixtures, GLM 5.3 defaults retained, output mode was 0600.
  Docker Compose parsing confirmed primary and backup wiring for the reward worker.
- Headless Chrome rendered the AI Providers Help page from the updated source,
  showing Vercel first, Ambient backup, GLM 5.3, and GLM 5.3 Flash.

The new XML parser dependency was installed in the existing local API dependency
volume and that local API container was restarted to recover its failed module
load. Local `/api/health` returned HTTP 200. Production containers were not restarted.

## Scope and remaining deployment work

No commit, push, application deployment, production migration, real user model
request, reward issuance, or Discord message was performed. Existing unrelated
worktree changes were preserved. Migration 132 must run on application deployment;
normal installation must install the updated lockfile. The existing isolated NFT
image renderer, deterministic embeddings, Corbanu research service, and independent
Kimi terminal runtime retain their service contracts.

## Deployment completion

`npm run fly:deploy:prod` completed successfully. Release v700 uses image
`deployment-01M1QPCRBS2KR3XSDA5VCF8E5K`, digest
`sha256:af576e665dfcc9a3d3cb49ff54c0bdeb4e70ef5e984f6949e9a958d0d7cbc29e`.
All 19 machines, including cold standbys, have that image. All 10 process groups
have one active machine with `restart=always`; the public app health check passes.

Migration `132_vercel_inference_defaults.sql` applied at
`2026-09-05T02:31:02.611Z`. Deployed source hashes for the routing/policy/protocol/
transport and chat modes match the reviewed working-tree snapshot. Both primary
models and a forced-failure Ambient backup completed valid synthetic JSON calls
through the installed application modules. Public `/health`, `/api/chat/modes`,
and `/api/system/status` returned HTTP 200.

Existing Hive project and task-review queue alerts remain visible in System
Status; they refer to overdue work and publication records predating this
release. This deployment did not repair or replay those records. No Git commit
or push was performed, and no provider secrets were changed.
