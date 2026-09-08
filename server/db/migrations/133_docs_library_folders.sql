ALTER TABLE docs_accounts
  ADD COLUMN IF NOT EXISTS encrypted_library_metadata jsonb,
  ADD COLUMN IF NOT EXISTS library_metadata_version integer NOT NULL DEFAULT 0;
