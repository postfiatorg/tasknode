-- Append-only during normal use, with deletion reserved for parent erasure.
ALTER TABLE prompt_history_events DROP CONSTRAINT prompt_history_events_document_id_fkey;
ALTER TABLE prompt_history_events ADD CONSTRAINT prompt_history_events_document_id_fkey
  FOREIGN KEY (document_id) REFERENCES docs_documents(document_id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION prompt_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (
    NOT EXISTS (SELECT 1 FROM docs_accounts WHERE account_id = OLD.account_id)
    OR NOT EXISTS (SELECT 1 FROM docs_documents WHERE document_id = OLD.document_id)
    OR EXISTS (SELECT 1 FROM docs_documents WHERE document_id = OLD.document_id AND status IN ('deleting', 'deleted'))
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'prompt_history_append_only';
END;
$$;

-- The account-deletion transaction already erases docs_accounts. Erase prompt
-- documents and devices here before the generic account-scoped row sweep.
CREATE FUNCTION erase_account_prompts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM docs_documents WHERE owner_account_id = OLD.account_id AND document_type = 'prompt';
  DELETE FROM prompt_history_events WHERE account_id = OLD.account_id;
  DELETE FROM prompt_devices WHERE account_id = OLD.account_id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER docs_account_erase_prompts AFTER DELETE ON docs_accounts
  FOR EACH ROW EXECUTE FUNCTION erase_account_prompts();

-- A soft-delete must erase history too; archiving remains reversible.
CREATE FUNCTION erase_deleted_prompt_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.document_type = 'prompt' AND NEW.status IN ('deleting', 'deleted') THEN
    DELETE FROM prompt_history_events WHERE document_id = NEW.document_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER docs_document_erase_prompt_history AFTER UPDATE OF status ON docs_documents
  FOR EACH ROW EXECUTE FUNCTION erase_deleted_prompt_history();
