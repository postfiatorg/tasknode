DELETE FROM context_revisions AS revision
USING context_documents AS document
WHERE revision.context_document_id = document.id
  AND document.current_revision_id IS NOT NULL
  AND revision.id <> document.current_revision_id
  AND revision.source IN ('native_editor', 'context_edit_chat_mode');
