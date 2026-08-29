UPDATE terminal_sessions
SET expires_at = NULL
WHERE revoked_at IS NULL
  AND expires_at IS NOT NULL;

COMMENT ON COLUMN terminal_sessions.expires_at IS
  'Legacy compatibility metadata only. Every unrevoked terminal session remains valid until explicit revocation.';
