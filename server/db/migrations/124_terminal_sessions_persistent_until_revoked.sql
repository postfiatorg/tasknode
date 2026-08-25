ALTER TABLE terminal_sessions
  ALTER COLUMN expires_at DROP NOT NULL;

UPDATE terminal_sessions
SET expires_at = NULL
WHERE revoked_at IS NULL
  AND expires_at > now();

COMMENT ON COLUMN terminal_sessions.expires_at IS
  'Compatibility expiry for historical terminal sessions. New sessions remain valid until revoked and store NULL.';
