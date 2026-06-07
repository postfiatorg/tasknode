# Defect Repair Rule

This page mirrors the workspace-level rule in `/home/pfrpc/repos/AGENTS.md`.
Use it when fixing reported app behavior, especially when the user gives one
concrete broken example.

## General Defect Repair Rule

When the user reports a broken app behavior with a concrete example, treat that
example as evidence of a general product or system failure mode. Do not repair
the issue by hard-coding the literal input, adding one-off regex routes,
inventing a special-case type, or stuffing the example into a prompt as the
solution.

The canonical repair path is:

1. Identify the underlying boundary that failed: routing, state, intent, policy,
   persistence, timeout, provider selection, permissions, or user workflow.
2. Fix that boundary directly so the whole behavior class is handled.
3. For chat, agent, Discord bot, or natural-language app behavior, use a small
   structured classifier/router on incoming messages when user intent determines
   the path.
4. Use model-based classification for semantic intent where the app already uses
   LLM behavior, with deterministic structured outputs and conservative fallback
   behavior.
5. Keep regex or literal checks only as low-level defensive fallbacks for
   mechanical protocol markers, never as the primary product behavior fix.
6. Add regression tests that prove the generalized behavior class is handled,
   including paraphrases or adjacent cases, not only the exact user-provided
   sentence.

Concrete examples from the user are test evidence and debugging anchors. They
are not implementation requirements to match exactly.

## How To Apply It

When a concrete report arrives, write the bug in this shape before changing
code:

- Reported example: the exact user-visible failure.
- Failed boundary: the system layer that generalized failure belongs to.
- Product fix: the boundary change that handles the class of failures.
- Regression proof: at least one adjacent or paraphrased case, not only the
  original example.

If the failure involves model behavior, prompts may be part of the repair, but
the prompt should define the rule or router contract. It should not paste the
user's one bad output as the product logic.
