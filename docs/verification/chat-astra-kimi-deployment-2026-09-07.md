# Astra and Kimi K3 production deployment

Deployed 2026-09-07 to https://tasknode.postfiat.org (Fly app tasknodeofficial-dev).

## Release

- Release: v728, complete.
- Image: registry.fly.io/tasknodeofficial-dev:deployment-01M1YRXTM8JD4481XSPEEDWEHM
- Rollback image: registry.fly.io/tasknodeofficial-dev:deployment-01M1Y3Q2FXBW0DNVTYAQZ8VQ5B (v727).
- Candidate snapshot: /mnt/HC_Volume_101713660/pfrpc/scratch/tasknode-astra-kimi-deploy-20260907
- Deployed with the repository's `npm run fly:deploy:prod` wrapper after migration and production preflight checks.
- Compared all 584 deployed runtime files with the working tree. Preserved the existing production version of server/tasknode-terminal-routes.js in the candidate to exclude an unrelated local edit. Source worktree edits remain intact.

## User behavior

Five model options: Instant, Thinking, GPT-6 Astra, Kimi K3, Help. Fable removed at the user's instruction. Astra and Kimi selection is exact and cannot silently substitute an Ambient model. The picker shows base API input/output pricing. Final charges equal Vercel's reported API cost without Task Node markup; missing cost prevents a guessed debit.

## Secrets

Imported VERCEL_ASTRA_API_KEY and VERCEL_KIMI_API_KEY through Fly secrets stdin with --stage and activated them with the deployment. Values came from the user-supplied text files, never command arguments or browser configuration. Each exact model uses its dedicated key in preference to generic Gateway credentials. Existing generic provider credentials were preserved. No Fable key was imported.

## Verification

- Focused routing/billing fixture passed, including per-model credential isolation, dedicated-key-only readiness, streaming cost preservation, ledger calculation, cache/long-context estimates, and no Fable option.
- Inference failover smoke: 105 assertions passed.
- Model compatibility and System Status tests passed.
- No-regex inference audit passed: 238 reachable files.
- Lint and production build passed.
- Browser fixture against candidate source passed at 1280px and 390px: five rendered options, rate descriptions, both model selections.
- Live /api/chat/modes returned both exact model IDs, configured true, provider_api_cost billing, and no Fable.
- Production SSH probes loaded the deployed inference/billing modules and the Fly secrets. Both models returned the correct arithmetic answer with successful streaming and provider-cost equality. Astra cost $0.001100; Kimi K3 cost $0.000307; total $0.001407. These probes did not write user chat or billing records.
- Live /health: ok=true, environment=production.
- Post-deploy background guard passed for all nine worker/board groups; app health passed.
- Detailed production response IDs and results: chat-astra-kimi-production-2026-09-07.json.

Production UI authentication was not automated; rendering/selection used a browser fixture, while live API configuration and inference were verified separately. No source push was performed.

## Selector visibility follow-up

After the user reported no visible selector, the full ChatSurface showed the existing trigger was labeled only Instant. Changed it to an explicit bordered Model: … button, added accessible labeling and focus indication, and moved mobile composer controls below the prompt to prevent the input being squeezed. Updated the Chat documentation with the location and ordinary-chat scope.

- Released v729, complete, image registry.fly.io/tasknodeofficial-dev:deployment-01M1YSSTASPKXCMG6GPG257345 through npm run fly:deploy:prod.
- Lint and production build passed. Post-deploy guards passed for all nine worker/board groups.
- Full-composer browser smoke passed at widths 1280, 768, 760, 390, and 320: visible trigger, prompt width, Enter activation, mouse selection of Astra and Kimi, account storage and remount persistence. Keyboard CDP events require carriage-return text to synthesize native Enter activation.
- Inspected the mobile screenshot after fixing the squeezed prompt.
- Real production browser, signed out, rendered the visible Model: Help button after session hydration. Authenticated selection remains covered by the full-composer fixture rather than a live authenticated browser session.
- Production /health returned ok=true and environment=production following release v729.
- Provider configuration, secrets and API-cost billing remain those verified above; this follow-up did not require additional paid inference.
