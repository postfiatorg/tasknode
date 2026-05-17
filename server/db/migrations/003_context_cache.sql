CREATE TABLE IF NOT EXISTS context_documents (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  title text NOT NULL DEFAULT 'Task Node Context',
  current_revision_id text,
  revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS context_documents_account_active_idx
  ON context_documents (account_id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS context_revisions (
  id text PRIMARY KEY,
  context_document_id text NOT NULL,
  account_id text NOT NULL,
  revision integer NOT NULL,
  title text NOT NULL DEFAULT 'Task Node Context',
  body text NOT NULL DEFAULT '',
  body_sha256 text NOT NULL DEFAULT '',
  word_count integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'native_editor',
  provenance_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT context_revisions_document_fk
    FOREIGN KEY (context_document_id)
    REFERENCES context_documents (id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS context_revisions_document_revision_idx
  ON context_revisions (context_document_id, revision);

CREATE INDEX IF NOT EXISTS context_revisions_account_recent_idx
  ON context_revisions (account_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS context_history_imports (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  wallet_address text NOT NULL,
  source text NOT NULL DEFAULT 'pftasks_indexed_snapshot',
  status text NOT NULL DEFAULT 'completed',
  pointer_count integer NOT NULL DEFAULT 0,
  context_update_count integer NOT NULL DEFAULT 0,
  task_event_count integer NOT NULL DEFAULT 0,
  error text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS context_history_imports_account_wallet_recent_idx
  ON context_history_imports (account_id, wallet_address, created_at DESC, id);

CREATE TABLE IF NOT EXISTS context_history_pointers (
  id text PRIMARY KEY,
  import_id text,
  account_id text NOT NULL,
  wallet_address text NOT NULL,
  cid text NOT NULL,
  pointer_type text NOT NULL DEFAULT 'context',
  kind integer,
  kind_label text,
  schema text,
  flags integer NOT NULL DEFAULT 0,
  task_id text,
  thread_id text,
  context_id text,
  tx_hash text,
  ledger_index bigint,
  memo_index integer,
  pointer_created_at timestamptz,
  account_address text,
  destination_address text,
  direction text,
  source text NOT NULL DEFAULT '',
  version text,
  word_count integer,
  event_id text,
  event_type text,
  title text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '',
  artifact_type text NOT NULL DEFAULT '',
  artifact_count integer,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT context_history_pointers_import_fk
    FOREIGN KEY (import_id)
    REFERENCES context_history_imports (id)
    ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS context_history_pointers_dedupe_idx
  ON context_history_pointers (
    account_id,
    wallet_address,
    COALESCE(tx_hash, ''),
    COALESCE(memo_index, -1),
    cid,
    COALESCE(task_id, ''),
    COALESCE(event_type, ''),
    pointer_type
  );

CREATE INDEX IF NOT EXISTS context_history_pointers_account_wallet_recent_idx
  ON context_history_pointers (
    account_id,
    wallet_address,
    pointer_created_at DESC NULLS LAST,
    ledger_index DESC NULLS LAST,
    id
  );

CREATE INDEX IF NOT EXISTS context_history_pointers_cid_idx
  ON context_history_pointers (account_id, wallet_address, cid);
