# PR-10 Review: Docs, Prompts, And Public Readiness

Date: 2026-05-25
Branch: `review/10-docs-prompts-public-readiness`
Base: `origin/main` @ `d01d391`

## Summary

Reviewed Help docs wiring (`docs/wiki/**`, `src/features/docs/docs-content.js`),
prompt registry usage (`prompts/**`, `server/prompt-registry.js`), public-readiness
hygiene (secrets, seeds, private paths), and legacy PFTasks / deferred-surface
cleanup. Production prompts load from files through `loadPrompt()` or Vite raw
imports; Help exposes auth, Hive, Board Manager (Plans), daily airdrop, profile,
network tasks, recovery, and the full prompt index. No committed provider keys or
wallet seeds were found. The repo is close to public-ready, but several tracked
docs and reference-client paths still hard-code operator-specific filesystem
locations.

## Findings

### P0

None.

### P1

1. **Operator-specific seed and home-directory paths remain in tracked reference code**
   - **File/line:** `reference_clients/python/tasknode_pftl/scenarios/app_request_lifecycle.py:43`, `reference_clients/python/README.md:37-38,100`, `docs/wiki/plans/getting-tasks-over-line.md:518-521`
   - **Severity:** P1 (public readiness)
   - **Impact:** Default `--user-seed-file` points at `/home/pfrpc/repos/ga_seed2.txt`. README and plan docs repeat that path and PFTasks `.env` locations. A public clone cannot run those examples without editing paths, and the filenames imply a real seed file layout.
   - **Verification:** `rg ga_seed2` across repo; no `ga_seed2.txt` is tracked, but the default constant and docs reference it.
   - **Fix:** Replace defaults with `./fixtures/example.seed` (or require explicit CLI flag) and rewrite README/plan examples to repo-relative paths.

2. **Deployment / Docker / Fly operator docs are outside Help**
   - **File/line:** `docs/DEPLOYMENT.md`, `docs/DOCKER_DEV.md`, `src/features/docs/docs-content.js`
   - **Severity:** P1 (doc coverage vs spec question)
   - **Impact:** PR-10 asks whether Help covers Docker/Fly data for newly shipped behavior. Fly bridge, compose overrides, and wallet-origin caveats live only in repo-root docs, not in the in-app Help tree wired through `docs-content.js`.
   - **Verification:** No `DEPLOYMENT` / `DOCKER` imports in `docs-content.js`; PR-02 review recorded bridge behavior separately.
   - **Fix:** Add Architecture or Plans Help pages that import `docs/DEPLOYMENT.md` and `docs/DOCKER_DEV.md`, or link from Start Here with a short “Local dev and Fly” section.

### P2

1. **Deferred tool wiki pages still describe active navigation that is absent**
   - **File/line:** `docs/wiki/surfaces/motivation.md:14`, `docs/wiki/surfaces/brainstorming-context.md:16`
   - **Severity:** P2
   - **Impact:** Motivation and Brainstorming docs claim sidebar/composer entry points in `src/main.jsx`, but those surfaces are not imported into Help and no Motivation/Brainstorm/Rewrite routes exist under `src/`. Misleading if someone reads wiki files directly.
   - **Verification:** `rg Motivation|Brainstorm|Rewrite src/` → no matches; `docs-content.js` omits those slugs.
   - **Fix:** Add a “Not shipped” banner at the top of deferred surface docs, or move them under `docs/wiki/plans/` until exposed.

2. **Legacy Jobs/Motivation prompt artifacts are orphaned**
   - **File/line:** `prompts/openai_jobs_motivation.md`, `prompts/openai_jobs_brainstorm.md`, `prompts/steve_jobs_*.md`, `prompts/README.md:18-19`
   - **Severity:** P2
   - **Impact:** Large prompt bodies remain in git but are not registered in `PROMPT_SOURCES`, not loaded by `loadPrompt()`, and not shown in Help. They read like shipped product policy for surfaces that are not in the app.
   - **Verification:** `prompts/README.md` labels them “Motivation/Jobs surfaces”; no runtime import besides unrelated Jobs Chat Spirit (`jobs_chat_os_v1.xml`).
   - **Fix:** Move to `docs/archive/` or delete once product confirms they will not ship; keep `jobs_chat_os_v1.xml` as the active Jobs voice.

3. **Small inline prompt wrappers remain beside file-loaded prompts**
   - **File/line:** `server/board-manager-decision-provider.js:122`, `server/repositories/board-manager.js:660`
   - **Severity:** P2
   - **Impact:** Board Manager loads `prompts/hive/board_manager_v1.md` but appends short runtime instructions inline. Acceptable for execution context, but reviewers must check both file and wrapper when changing policy.
   - **Verification:** Read decision provider and repository formatters.
   - **Fix:** Document wrapper text in the prompt file header or keep as-is with explicit comment that wrappers are non-semantic.

4. **`taskgen_repair_v1.md` is reserved with no runtime caller**
   - **File/line:** `src/features/docs/docs-content.js:291-295`, `prompts/task_engine/taskgen_repair_v1.md`
   - **Severity:** P2
   - **Impact:** Help correctly marks status “Reserved / No runtime caller yet”. No user-facing claim of active repair behavior.
   - **Verification:** `rg taskgen_repair` → docs only.
   - **Fix:** None required until repair path ships.

5. **Secret-scan and Help screenshot evidence gaps**
   - **Severity:** P2 (evidence)
   - **Impact:** Scan hits are env var names, placeholder DATABASE URLs, and fixture tokens (e.g. `scripts/auth-login-state-fixture.mjs` fake Telegram token). No live secrets found. Help burndown page screenshot was not captured in this headless review environment.
   - **Verification:** Redacted `rg` output below; `npm run build` succeeds and bundles `DocsView` with wiki markdown.
   - **Fix:** Integration owner may attach Help → Plans → Code Review Burndown screenshot when merging.

6. **Burndown row 2 lagged merged PR-02**
   - **File/line:** `docs/review_burndown/burndown.md:43`
   - **Severity:** P2 (meta accuracy)
   - **Impact:** `origin/main` includes merge commit for PR-02 (`review/02-deploy-docker-fly-data`) but burndown still listed `review_ready`.
   - **Fix:** Included on this branch — row 2 set to `merged`.

## What Looks Correct

- `src/features/docs/docs-content.js` wires Start, Surfaces, Architecture, Prompts, and Plans groups; newly shipped areas include auth, Hive, profile, daily airdrop, network-task recovery, and Board Manager plans.
- Brainstorming, Motivation, and Rewrite are absent from Help navigation and `src/` routing.
- Twenty-one active prompts are imported from `prompts/**`; Help renders live prompt text via Vite raw imports and records runtime call sites.
- `server/prompt-registry.js` centralizes file loading; workers record prompt digests on persisted outputs.
- `private_prompts/` and `.env.*` are gitignored; `git ls-files '*.env*'` returns nothing tracked.
- `RULES.md` states prompt-first product policy; aligns with repo conventions.
- PFTasks references in `full_spec.md`, `product_spec.md`, and migration plans are labeled historical or reference-only, not current behavior.
- Profile NFT uses a public placeholder; production image prompt stays in ignored `private_prompts/`.

## Secret Scan (Redacted)

Command:

```bash
rg -n "sEd|TELEGRAM_AUTH_BOT_TOKEN|OPENAI_API_KEY|DEEPSEEK_API_KEY|RESEND_API_KEY|DATABASE_URL=.*://" . \
  --glob '!node_modules/**' --glob '!dist/**'
```

Results (redacted categories, no live values):

| Category | Count | Notes |
| --- | --- | --- |
| Env var documentation | ~25 | `docs/BOOTUP.md`, `docs/wiki/architecture/auth-and-connected-accounts.md`, provider docs — names only |
| Example DATABASE URLs | ~12 | `postgres://tasknodeofficial:***@localhost:5436/tasknodeofficial` placeholders |
| Runtime env reads | ~20 | `process.env.OPENAI_API_KEY` etc. in server code — expected |
| Smoke/fixture assignments | ~8 | Fake keys like `board-manager-smoke-openai-key`, `123456:tasknode-telegram-secret` in test scripts |
| Test seed string | 1 | `sEdServiceSeedMaterialForDerivationOnly` in encryption unit test (not a wallet seed) |
| False positives | 3 | `isEditing` prop matches `sEd` substring in mock JSX |

**No committed live API keys, bot tokens, Resend keys, or real wallet seeds.**

## Fixes Included On This Branch

1. Updated `docs/review_burndown/burndown.md`: PR-02 → `merged`; PR-10 → `complete` with findings link; series progress note; date stamp.
2. Added this review document.

## Checks Run

```bash
npm ci
npm run quality
npm run build
git diff --check
rg -n "sEd|TELEGRAM_AUTH_BOT_TOKEN|OPENAI_API_KEY|DEEPSEEK_API_KEY|RESEND_API_KEY|DATABASE_URL=.*://" . \
  --glob '!node_modules/**' --glob '!dist/**'
git ls-files '*.env*' 'secrets*' 'private_prompts/**'
```

Manual evidence:

- Read `docs-content.js` Help tree vs `docs/wiki/surfaces/*` and burndown queue.
- Confirmed deferred surfaces absent from `src/` and Help.
- Build produced `dist/assets/DocsView-*.js` (~792 kB) containing bundled wiki markdown.

## Residual Risks

- Public clone still needs path rewrites in Python reference README and lifecycle scenario defaults.
- Operator docs for Fly/Docker remain outside Help until wired into `docs-content.js`.
- Orphan Jobs/Motivation prompt files may confuse open-source readers about shipped scope.
- Help screenshot evidence deferred to integration merge step.

## Merge Recommendation

**Do not merge** (per review workflow — integration owner merges after re-check). Findings are documentation and public-hygiene gaps, not blockers for continuing product work. Address P1 path cleanup before flipping the repository public.

---

```text
Review PR: PR-10
Boundary: Help docs, prompt registry, public readiness, legacy cleanup
Branch: review/10-docs-prompts-public-readiness
Changed files:
  docs/review_burndown/reviews/pr-10-docs-prompts-public-readiness.md
  docs/review_burndown/burndown.md
Findings:
- P0: none
- P1: operator-specific seed/home paths in reference client; Docker/Fly docs not in Help
- P2: stale deferred-surface wiki claims; orphan Jobs prompt files; inline BM wrappers; burndown PR-02 lag (fixed)
Fixes included: burndown accuracy for PR-02 merged and PR-10 complete
Checks run: npm run quality, npm run build, git diff --check, secret scan (redacted)
Manual app evidence: docs-content.js + build bundle review; Help screenshot deferred
Residual risks: public path examples; orphan prompts; deployment docs outside Help
Merge recommendation: do not merge (review-only handoff); fix P1 paths before public release
```
