-- Operator scope for the board manager (2026-11-15). The rules live in
-- server/board-work-policy.js; this keeps the stored board text and routing
-- constraints in step with them.

-- Closed to new tasks. In-flight work is still reviewed and paid, so the
-- boards stay active; routing is disabled.
UPDATE network_projects
   SET metadata_json = jsonb_set(coalesce(metadata_json, '{}'::jsonb), '{routing_constraints}',
         coalesce(metadata_json->'routing_constraints', '{}'::jsonb) || '{"routing_disabled": true}'::jsonb, true),
       phase_label = 'Closed to new tasks',
       objective = 'Closed to new tasks on 2026-11-15. Work already offered or accepted is reviewed and paid on its own terms.',
       updated_at = now()
 WHERE id IN ('board_pf_terminal', 'board_ai_l1_governance');

-- Task Node is a public repository: fixes arrive as pull requests from
-- core contributors. Only the operator merges.
UPDATE network_projects
   SET metadata_json = jsonb_set(coalesce(metadata_json, '{}'::jsonb), '{routing_constraints}',
         coalesce(metadata_json->'routing_constraints', '{}'::jsonb) - 'assignable_handles', true),
       objective = 'Repair and harden Task Node through pull requests merged into the public repository.',
       about = 'This board tracks reproduced defects and hardening work on Task Node. Contributors with a core contributor badge fix them through pull requests to postfiatorg/tasknode; payment requires the pull request to be merged. Only goodalexander merges and deploys.',
       updated_at = now()
 WHERE id = 'board_tasknode_fixes';

UPDATE network_projects
   SET summary = 'Education, amplification and community building for Post Fiat.',
       objective = 'Bring people into Post Fiat, Task Node and the Discord through education posts, amplification of official and goodalexander content, and community events.',
       about = 'This board pays for public work that can be opened and checked: education and onboarding posts about Post Fiat, Task Node or joining the Discord; amplification of official Post Fiat and goodalexander content; and community events and masterminds. Proof is the public link. Pull requests are never required here.',
       metadata_json = jsonb_set(coalesce(metadata_json, '{}'::jsonb), '{evidence_norms}', '["public_link", "x_link"]'::jsonb, true),
       updated_at = now()
 WHERE id = 'board_community_promotion';

UPDATE network_projects
   SET summary = 'Actionable alpha and amplification of goodalexander research.',
       objective = 'Pay only for actionable, sourced alpha and for amplification of research and trade ideas goodalexander has already published. High bar; usually empty.',
       about = 'This board pays for two things: a specific, sourced, testable idea someone could act on, published by the contributor; and amplification of existing goodalexander research and trade ideas, including NAVCoin posts. It does not pay for plans, specifications, data-pull definitions or commentary. Proof is the public link.',
       metadata_json = jsonb_set(coalesce(metadata_json, '{}'::jsonb), '{evidence_norms}', '["public_link", "x_link"]'::jsonb, true),
       updated_at = now()
 WHERE id = 'board_capital_markets';

UPDATE network_projects
   SET objective = 'Advance PostfiatL1V2 through merged code changes and written code reviews of the protocol and its primitives.',
       about = 'This board routes two kinds of work on the second version of the Post Fiat L1: code changes, paid on a merged pull request, and code reviews, paid on a public written review tied to a commit with findings by file and line.',
       metadata_json = jsonb_set(coalesce(metadata_json, '{}'::jsonb), '{evidence_norms}', '["github_pr", "public_link"]'::jsonb, true),
       updated_at = now()
 WHERE id = 'board_postfiat_l1v2';
