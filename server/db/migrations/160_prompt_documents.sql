ALTER TABLE docs_documents DROP CONSTRAINT docs_documents_document_type_check;
ALTER TABLE docs_documents ADD CONSTRAINT docs_documents_document_type_check
  CHECK (document_type IN ('rich_text', 'prompt'));
ALTER TABLE docs_accounts ADD COLUMN encrypted_prompt_library_key jsonb;

-- Event kind, text, timing and scores live exclusively inside ciphertext.
CREATE TABLE prompt_history_events (
  event_id uuid PRIMARY KEY,
  account_id text NOT NULL,
  document_id uuid NOT NULL REFERENCES docs_documents(document_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  ciphertext jsonb NOT NULL
);
CREATE INDEX prompt_history_account_order ON prompt_history_events(account_id, created_at, event_id);
CREATE FUNCTION prompt_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'prompt_history_append_only'; END;
$$;
CREATE TRIGGER prompt_history_no_mutation BEFORE UPDATE OR DELETE ON prompt_history_events
  FOR EACH ROW EXECUTE FUNCTION prompt_history_append_only();
