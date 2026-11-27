-- Five boards and a Wanted list (operator decision, 2026-11-25).
--
-- The board manager used to start from idle contributors and invent work for
-- them. Work now starts from a Wanted list: one row per thing Post Fiat needs,
-- each with a link to where the need came from. A network task can only be
-- created from an open Wanted item, and one item has one live task at a time.
--
-- The public boards are Layer 1, Task Node, Corbanu Terminal, Trading and
-- Media. Board ids are unchanged so task history stays attached.

CREATE TABLE IF NOT EXISTS board_wanted_items (
  id text PRIMARY KEY,
  board_id text NOT NULL REFERENCES network_projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  why text NOT NULL,
  source_url text NOT NULL,
  work_type text NOT NULL DEFAULT '',
  reward_pft numeric(20, 6) NOT NULL DEFAULT 0,
  preferred_account_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  run_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL DEFAULT '',
  revised_at timestamptz NOT NULL DEFAULT now(),
  dropped_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT board_wanted_items_status_chk CHECK (status IN ('open', 'dropped'))
);

CREATE INDEX IF NOT EXISTS board_wanted_items_board_idx
  ON board_wanted_items (board_id, status, created_at);

-- Layer 1
UPDATE network_projects
   SET title = 'Layer 1',
       summary = 'Fixes, code reviews and new validators for the Post Fiat Layer 1.',
       objective = 'Make the Post Fiat Layer 1 better and more decentralised: bug fixes merged into postfiatl1v2, public code reviews, and new validators running.',
       about = 'Work on the Post Fiat Layer 1 (postfiatl1v2). Code changes are paid on a merged pull request. Code reviews are paid on a public written review tied to a commit. New validators are paid once the validator is running and listed on the network. Every task comes from an item on this board''s Wanted list.',
       phase_label = '',
       updated_at = now()
 WHERE id = 'board_postfiat_l1v2';

-- Task Node
UPDATE network_projects
   SET title = 'Task Node',
       summary = 'Bug fixes and testing for Task Node.',
       objective = 'Make Task Node work for every member: bug fixes merged into the public repository, and testing that ends in a fix.',
       about = 'Work on Task Node. Fixes are paid on a pull request merged into the public repository. Testing is paid when a reproduced defect ends in a fix. Every task comes from an item on this board''s Wanted list.',
       phase_label = '',
       updated_at = now()
 WHERE id = 'board_tasknode_fixes';

-- Corbanu Terminal (was "PF Terminal"; open again)
UPDATE network_projects
   SET title = 'Corbanu Terminal',
       summary = 'Work on Corbanu Terminal.',
       objective = 'Improve Corbanu Terminal through pull requests merged into CorbanuCore/CorbanuTerminal.',
       about = 'Work on Corbanu Terminal. Code changes are paid on a pull request merged into CorbanuCore/CorbanuTerminal. Every task comes from an item on this board''s Wanted list.',
       phase_label = '',
       metadata_json = jsonb_set(coalesce(metadata_json, '{}'::jsonb), '{routing_constraints}',
         coalesce(metadata_json->'routing_constraints', '{}'::jsonb) - 'routing_disabled', true),
       updated_at = now()
 WHERE id = 'board_pf_terminal';

-- Trading
UPDATE network_projects
   SET title = 'Trading',
       summary = 'Actionable trading information and goodalexander trade ideas.',
       objective = 'Give the community trading information it can act on, and spread goodalexander trade ideas.',
       about = 'Two kinds of work: a specific, sourced trading idea someone could act on, published by the contributor; and spreading goodalexander trade ideas and research. Proof is the public link. Every task comes from an item on this board''s Wanted list.',
       phase_label = '',
       updated_at = now()
 WHERE id = 'board_capital_markets';

-- Media
UPDATE network_projects
   SET title = 'Media',
       summary = 'Explaining and promoting Post Fiat, hype content and community.',
       objective = 'Bring people to Post Fiat: explain it, promote it, make content about it and build the community.',
       about = 'Posts, threads, walkthroughs, videos, clips and community events about Post Fiat, Task Node and NAVCoins. Proof is the public link. Every task comes from an item on this board''s Wanted list.',
       phase_label = '',
       updated_at = now()
 WHERE id = 'board_community_promotion';

-- Off the public board. AI Layer 1 Governance finishes its in-flight work and
-- takes nothing new; the penalty boards keep working out of sight.
UPDATE network_projects
   SET metadata_json = jsonb_set(coalesce(metadata_json, '{}'::jsonb), '{hive_hidden}', 'true'::jsonb, true),
       updated_at = now()
 WHERE id IN ('board_ai_l1_governance', 'board_value_accountability', 'board_reinstatement');

-- Board order on the Hive page, as the operator listed them.
UPDATE network_projects SET priority = 1 WHERE id = 'board_postfiat_l1v2';
UPDATE network_projects SET priority = 2 WHERE id = 'board_tasknode_fixes';
UPDATE network_projects SET priority = 3 WHERE id = 'board_pf_terminal';
UPDATE network_projects SET priority = 4 WHERE id = 'board_capital_markets';
UPDATE network_projects SET priority = 5 WHERE id = 'board_community_promotion';
