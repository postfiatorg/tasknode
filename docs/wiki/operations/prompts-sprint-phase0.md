# Prompts sprint: Phase 0 gate (2026-11-11)

Phase 0 is blocked at the production browser gate. Phases 1–3 have not started.
The headless Node protocol passes locally when the markdown app is enabled, but
production PFDocs currently disables `/code/`.

Implementation and raw evidence: [PFDocs draft PR #2](https://github.com/agtico/pftdocs/pull/2).
This Task Node branch changes documentation only. It does not claim a prompt type,
prompt library, encrypted history, device approval, or local MCP support.

## Demonstration

The spike uses `chainpad`, `chainpad-netflux`, `chainpad-crypto`, and
`netflux-websocket` with the CryptPad v2 edit capability and signed JSON code state.
It uses an isolated real Chromium page and the real local PFDocs service.

1. Node initializes synthetic markdown and reconnects to read persisted text.
2. The browser renders that text and edits it; Node observes the browser edit.
3. Node reconnects with the edit capability and reads the browser's current text.
4. Node edits the text; the same browser tab displays the edit live.

That local sequence passed. The only local app customization adds `code` to
`availablePadTypes`; browser security settings and responses were not bypassed.

On `tasknode-pfdocs.fly.dev`, Node created and reopened one synthetic test pad.
The browser displayed “This application has been disabled. Contact the
administrator of this PFT Docs for more information.” The public configuration
lists only `drive`, `pad`, and `sheet`. A second diagnostic run reused the same
pad and reported `BROWSER_APP_DISABLED`; no second production test pad was created.

Both instances also emitted a WebAssembly CSP diagnostic. The local success with
CSP untouched shows that this is not the demonstrated collaboration blocker.

## Production/source differences

PFDocs remote main was `206cacdc798df09ea7eaa0b6abd38e6aee4034c8`.
Production public `sframe-common.js` and `sframe-common-outer.js` differed from that
base, including assistant protocol/budget, document text, and embed/readiness/chat
changes. Three other sampled files matched. Exact hashes and the public-source
diff are in PFDocs PR #2; this comparison does not establish the server revision.

Task Node base was `e28de47` from a fresh `origin/main` fetch in a newly created
worktree. Existing worktrees and tmux sessions were not modified.

## Required next actions

NEEDS-MANAGER: spike failed at the production browser gate because the markdown
app is disabled. Enable `/code/` through the manager-reviewed production path and
rerun the existing Phase 0 spike before starting Phases 1–3. The build orc must not
deploy to Fly or merge main.

NEEDS-MANAGER: reconcile production PFDocs build/source provenance with repository
main before deploying changes from this base.

The synthetic pad capability is retained privately in the new PFDocs checkout's
ignored artifacts directory for reuse. It is not included in the PR or status.
The sprint record and raw runs are also available locally at
`/home/postfiat/repos/orc_directives/prompts-sprint/STATUS.md` and `spike/` beside it.

The required ciphertext storage, stats math, device wrap/unwrap, and assistant
route regressions remain part of the blocked phases. No Task Node end-to-end
completion or history database dump is claimed.

During the separate CryptPad 2026.10 upgrade, revalidate v2 capability parsing,
code document JSON, SmartJSONTransformer, and the four protocol libraries.
