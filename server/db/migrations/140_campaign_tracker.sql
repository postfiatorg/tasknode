-- Campaign Tracker owns a distinct grant scope; task_history_v1 never exposes prompts.
CREATE TABLE campaign_tracker_enrollments (
  account_id text NOT NULL, workspace_id text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  policy_version integer NOT NULL DEFAULT 1, enrolled_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(account_id, workspace_id)
);
CREATE TABLE campaign_tracker_activity (
  account_id text NOT NULL, event_id text NOT NULL, instance_id text NOT NULL,
  session_id text NOT NULL, turn_id text NOT NULL, sequence bigint NOT NULL,
  workspace_id text NOT NULL, kind text NOT NULL,
  occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '365 days'),
  payload_digest text NOT NULL, payload_envelope jsonb NOT NULL,
  payload_bytes bigint NOT NULL CHECK(payload_bytes >= 0), revision integer NOT NULL DEFAULT 1,
  summary_state text NOT NULL DEFAULT 'not_applicable', processing_until timestamptz,
  PRIMARY KEY(account_id,event_id), UNIQUE(account_id,instance_id,sequence)
);
CREATE INDEX campaign_tracker_timeline ON campaign_tracker_activity(account_id,occurred_at DESC,event_id DESC);
CREATE INDEX campaign_tracker_session ON campaign_tracker_activity(account_id,session_id,occurred_at,event_id);
CREATE INDEX campaign_tracker_expiry ON campaign_tracker_activity(expires_at);
CREATE TABLE campaign_tracker_tombstones (
  account_id text NOT NULL, event_id text NOT NULL, deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,event_id)
);
CREATE TABLE campaign_tracker_grants (
  grant_id text PRIMARY KEY, subject_account_id text NOT NULL, viewer_account_id text NOT NULL,
  relationship_grant_id uuid NOT NULL REFERENCES task_history_grants(grant_id),
  capabilities jsonb NOT NULL, workspace_ids jsonb NOT NULL DEFAULT '[]',
  history_from timestamptz NOT NULL, history_to timestamptz, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  CHECK(subject_account_id <> viewer_account_id), CHECK(history_to IS NULL OR history_to > history_from)
);
CREATE INDEX campaign_tracker_viewer ON campaign_tracker_grants(viewer_account_id,subject_account_id);
CREATE TABLE campaign_tracker_audit (
  id bigserial PRIMARY KEY, actor_account_id text NOT NULL, subject_account_id text NOT NULL,
  action text NOT NULL, resource_id text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaign_tracker_audit_subject ON campaign_tracker_audit(subject_account_id,occurred_at DESC);
CREATE TABLE campaign_tracker_campaigns (
  campaign_id text PRIMARY KEY, owner_account_id text NOT NULL,
  payload_envelope jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE campaign_tracker_annotations (
  annotation_id text PRIMARY KEY, account_id text NOT NULL, event_id text NOT NULL,
  actor_account_id text NOT NULL, kind text NOT NULL, source_revision integer NOT NULL,
  payload_envelope jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(account_id,event_id) REFERENCES campaign_tracker_activity(account_id,event_id) ON DELETE CASCADE
);
