CREATE TABLE IF NOT EXISTS collaboration_wallet_challenges (
  challenge_id uuid PRIMARY KEY,
  account_id text NOT NULL,
  wallet_address text NOT NULL,
  action text NOT NULL,
  resource_id text NOT NULL DEFAULT '',
  payload_digest text NOT NULL,
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collaboration_wallet_challenges_account_recent_idx
  ON collaboration_wallet_challenges (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS docs_accounts (
  account_id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'locked', 'rekey_required', 'disabled')),
  pfdocs_account_hash text NOT NULL UNIQUE,
  encrypted_root_key_envelope jsonb NOT NULL,
  envelope_wallet_address text NOT NULL,
  envelope_key_version integer NOT NULL DEFAULT 1,
  storage_limit_bytes bigint NOT NULL DEFAULT 52428800,
  storage_used_bytes bigint NOT NULL DEFAULT 0,
  initialized_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_opened_at timestamptz
);

CREATE TABLE IF NOT EXISTS docs_documents (
  document_id uuid PRIMARY KEY,
  owner_account_id text NOT NULL,
  pfdocs_channel_hash text NOT NULL,
  document_type text NOT NULL DEFAULT 'rich_text'
    CHECK (document_type = 'rich_text'),
  encrypted_metadata jsonb NOT NULL,
  metadata_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('creating', 'active', 'archived', 'deleting', 'deleted', 'orphaned')),
  storage_bytes bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  delete_after timestamptz,
  UNIQUE (owner_account_id, pfdocs_channel_hash)
);

CREATE INDEX IF NOT EXISTS docs_documents_owner_recent_idx
  ON docs_documents (owner_account_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS docs_access_grants (
  grant_id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES docs_documents(document_id) ON DELETE CASCADE,
  owner_account_id text NOT NULL,
  recipient_account_id text NOT NULL,
  recipient_wallet_address text NOT NULL,
  access_role text NOT NULL CHECK (access_role IN ('viewer', 'editor')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'left')),
  encrypted_capability_envelope jsonb NOT NULL,
  transport text NOT NULL DEFAULT 'tasknode_mailbox'
    CHECK (transport IN ('tasknode_mailbox', 'tasknode_mailbox+nostr')),
  nostr_event_id text,
  transport_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  signature_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS docs_access_grants_active_recipient_idx
  ON docs_access_grants (document_id, recipient_account_id)
  WHERE status IN ('pending', 'accepted');

CREATE INDEX IF NOT EXISTS docs_access_grants_recipient_recent_idx
  ON docs_access_grants (recipient_account_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS docs_task_links (
  document_id uuid NOT NULL REFERENCES docs_documents(document_id) ON DELETE CASCADE,
  task_id text NOT NULL,
  linked_by_account_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, task_id)
);

CREATE TABLE IF NOT EXISTS team_relationship_invites (
  invite_id uuid PRIMARY KEY,
  inviter_account_id text NOT NULL,
  invitee_account_id text NOT NULL,
  requested_relationship text NOT NULL
    CHECK (requested_relationship IN ('collaborator', 'manager', 'direct_report')),
  requested_grants_json jsonb NOT NULL,
  canonical_payload jsonb NOT NULL,
  wallet_signature text NOT NULL,
  signer_public_key text NOT NULL,
  signer_wallet_address text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  expires_at timestamptz NOT NULL,
  signature_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  terminal_at timestamptz,
  terminal_actor_account_id text,
  CHECK (inviter_account_id <> invitee_account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS team_relationship_invites_pending_pair_idx
  ON team_relationship_invites (
    LEAST(inviter_account_id, invitee_account_id),
    GREATEST(inviter_account_id, invitee_account_id)
  )
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS team_relationship_invites_invitee_recent_idx
  ON team_relationship_invites (invitee_account_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_history_grants (
  grant_id uuid PRIMARY KEY,
  subject_account_id text NOT NULL,
  viewer_account_id text NOT NULL,
  scope text NOT NULL DEFAULT 'task_history_v1'
    CHECK (scope = 'task_history_v1'),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'expired')),
  subject_wallet_address text NOT NULL,
  canonical_payload jsonb NOT NULL,
  wallet_signature text NOT NULL,
  signer_public_key text NOT NULL,
  signature_hash text NOT NULL,
  source_invite_id uuid REFERENCES team_relationship_invites(invite_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (subject_account_id <> viewer_account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS task_history_grants_active_direction_idx
  ON task_history_grants (subject_account_id, viewer_account_id, scope)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS task_history_grants_viewer_idx
  ON task_history_grants (viewer_account_id, status, activated_at DESC);

CREATE TABLE IF NOT EXISTS account_nostr_identities (
  account_id text PRIMARY KEY,
  nostr_pubkey_hex text NOT NULL UNIQUE,
  npub text NOT NULL,
  nip05 text,
  nip05_verified_at timestamptz,
  preferred_relays jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_wallet_address text NOT NULL,
  wallet_proof jsonb NOT NULL,
  sequence bigint NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  visibility text NOT NULL DEFAULT 'teammates'
    CHECK (visibility IN ('private', 'teammates', 'public')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS collaboration_audit_events (
  event_id uuid PRIMARY KEY,
  account_id text NOT NULL,
  event_type text NOT NULL,
  subject_account_id text,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  result_status text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collaboration_audit_events_account_recent_idx
  ON collaboration_audit_events (account_id, created_at DESC);
