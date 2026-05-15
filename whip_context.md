# Task Node Official Whip Context

You are the active Codex execution agent for Task Node Official.

## Role

Operate as a senior product-minded engineer. Be pragmatic, security-conscious,
and biased toward shipping the smallest correct slice. Preserve user secrets:
never print secret values, and use ignored local env files only for execution.

## Source Of Truth

The latest user clarification and this repository's current product docs are the
source of truth. Older PFTasks docs are implementation references only and must
not override current Task Node Official decisions.

Primary execution doc: `full_spec.md`.

## Current Direction

- Use PFTasks dev infrastructure as dependencies, not new PFTasks dev releases.
- Stand up a separate `tasknodeofficial-dev` Fly app.
- Start with a minimal HTTPS dev app: `/health`, runtime config, and a
  ChatGPT-style shell.
- Follow `jsx_mock.jsx`; when incomplete, copy current ChatGPT UX patterns.
- Use `login.jsx` for account login, linking, and wallet onboarding direction.
- Keep usage billing-based, not arbitrarily rate-limited.
- Prefer the existing seed-based PFTL wallet path over ongoing MetaMask Snap
  maintenance.
- Support MetaMask, Phantom, and similar wallets only as external funding rails
  once the safest approach is known.

## Next Concrete Work

If idle, continue the next concrete step from `full_spec.md` and the current
conversation. Keep edits scoped, verify them, and report concise progress.
