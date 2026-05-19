# RULES

## Cardinal Prompt Rule

Prompt-governed product behavior belongs in prompts.

Do not implement semantic product policy with regex, keyword lists, hard-coded
classifiers, literal phrase matching, or one-off code paths.

If task generation, verification, scoring, chat behavior, memory behavior, or
agent behavior needs to change, change the relevant prompt contract and prompt
text first. The model should receive the instruction in plain language and make
the judgment in context.

## Prompt Logic

Prompts are the source of truth for semantic decisions such as:

- what evidence a task should request;
- whether a task is likely private or public;
- what verification follow-up is appropriate;
- what scoring standard applies;
- what the user intent means;
- what behavior the assistant should prefer.

Code should pass the right structured context into the prompt, enforce schemas,
record prompt versions and digests, and persist outputs. Code should not
recreate prompt policy with hidden branching logic.

## No Hidden Product Logic

Do not fix prompt failures by adding:

- regex checks for user wording;
- keyword arrays for semantic routing;
- hard-coded examples from a user report;
- special-case task IDs, wallet IDs, chat names, or phrases;
- silent rewrites of model output based on guessed intent.

Concrete examples from users are debugging evidence. They are not product logic.

## Acceptable Deterministic Code

Deterministic code is acceptable only for mechanical boundaries:

- JSON schema validation;
- required field validation;
- canonical serialization;
- cryptographic hashing;
- database persistence;
- PFTL pointer encoding and decoding;
- IPFS upload and fetch plumbing;
- provider request and response transport;
- explicit user-selected UI controls.

If a decision requires understanding meaning, intent, quality, privacy,
appropriateness, or verification strategy, it belongs in a prompt.
