INSERT INTO network_projects (id,type,title,objective,metadata_json)
VALUES ('board_reinstatement','network_validation','Account reinstatement',
  'Review evidence for restoring contributor access.',
  '{"deterministic":true,"board_manager_v2":true,"routing_constraints":{"routing_disabled":true}}');

CREATE INDEX blacklist_account_history ON account_blacklist(account_id, created_at DESC);

-- Each current ownership mismatch is one operator work item. Correcting a link
-- or closing its source entry removes it from the queue automatically.
CREATE VIEW reinstatement_wallet_conflicts AS
  SELECT b.id AS blacklist_id, w.account_id, w.wallet_address,
         greatest(b.created_at,w.linked_at) AS opened_at
    FROM account_blacklist b JOIN account_linked_wallets w ON b.wallet_addresses @> ARRAY[w.wallet_address]
   WHERE b.status='active' AND w.status='linked' AND w.account_id<>b.account_id;

CREATE TABLE reinstatement_cases (
  blacklist_id text PRIMARY KEY REFERENCES account_blacklist(id),
  eligible_at timestamptz NOT NULL,
  task_id text UNIQUE,
  stage text NOT NULL DEFAULT 'waiting' CHECK (stage IN ('waiting','offered','working','paused','submitted','resolved')),
  revision integer NOT NULL DEFAULT 0,
  evidence text NOT NULL DEFAULT '',
  feedback text NOT NULL DEFAULT '',
  submitted_at timestamptz,
  review_escalated_at timestamptz,
  reviewer text,
  lease_token uuid,
  lease_until timestamptz,
  failures integer NOT NULL DEFAULT 0,
  retry_at timestamptz,
  resolved_via text CHECK (resolved_via IN ('task','override'))
);
CREATE INDEX reinstatement_due ON reinstatement_cases (eligible_at) WHERE stage='waiting';

CREATE FUNCTION create_reinstatement_case() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO reinstatement_cases(blacklist_id,eligible_at) VALUES (NEW.id,NEW.created_at+interval '24 hours');
  RETURN NEW;
END $$;
CREATE TRIGGER blacklist_reinstatement AFTER INSERT ON account_blacklist
  FOR EACH ROW WHEN (NEW.status='active') EXECUTE FUNCTION create_reinstatement_case();
INSERT INTO reinstatement_cases (blacklist_id,eligible_at)
  SELECT id,created_at+interval '24 hours' FROM account_blacklist WHERE status='active';

-- One independently verified operator per account. Re-enrollment generates a new identity for voting.
CREATE TABLE reinstatement_operators (
  account_id text PRIMARY KEY REFERENCES app_accounts(account_id) ON DELETE CASCADE,
  enrollment uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()
);
CREATE TABLE reinstatement_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blacklist_id text NOT NULL REFERENCES reinstatement_cases,
  opened_by text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','cancelled','resolved','superseded'))
);
CREATE UNIQUE INDEX reinstatement_open_override ON reinstatement_overrides(blacklist_id) WHERE status='open';
CREATE TABLE reinstatement_votes (
  request_id uuid NOT NULL REFERENCES reinstatement_overrides,
  enrollment uuid NOT NULL REFERENCES reinstatement_operators(enrollment) ON DELETE CASCADE,
  PRIMARY KEY(request_id,enrollment)
);
CREATE TABLE reinstatement_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  blacklist_id text NOT NULL REFERENCES reinstatement_cases,
  actor text NOT NULL,
  action text NOT NULL,
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reinstatement_history_entry ON reinstatement_history(blacklist_id,id);
-- During rolling deploys an old CLI must also obey the new resolution contract.
CREATE FUNCTION require_reinstatement_resolution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT FROM reinstatement_cases WHERE blacklist_id=NEW.id AND stage='resolved' AND resolved_via IS NOT NULL) THEN
    RAISE EXCEPTION 'reinstatement_resolution_required';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER blacklist_lift_check BEFORE UPDATE OF status ON account_blacklist
  FOR EACH ROW WHEN (OLD.status='active' AND NEW.status='lifted') EXECUTE FUNCTION require_reinstatement_resolution();

-- Keep the current managed reviewer's scoped credential in sync with agents.json.
UPDATE board_agent_credentials SET board_ids = board_ids || '["board_reinstatement"]'::jsonb
 WHERE actor='board_manager_pfterminal' AND revoked_at IS NULL AND expires_at>now()
   AND board_ids ? 'board_value_accountability' AND NOT board_ids ? 'board_reinstatement';
