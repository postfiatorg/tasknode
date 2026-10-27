-- Agent tokens become per-device records the user can see and revoke:
-- a label ("Claude Code, Codex on postfiat-box"), last use, and an idle
-- expiry. Existing tokens start their idle clock at this migration.
ALTER TABLE terminal_sessions
  ADD COLUMN IF NOT EXISTS device_label text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS client_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS first_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_ip text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS idle_expiry_days integer NOT NULL DEFAULT 90;

UPDATE terminal_sessions
   SET last_used_at = now()
 WHERE last_used_at IS NULL
   AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS terminal_sessions_account_active_idx
  ON terminal_sessions (account_id, last_used_at DESC)
  WHERE revoked_at IS NULL;

-- Device sign-in looks pending requests up by the code the user types.
CREATE INDEX IF NOT EXISTS terminal_auth_requests_pending_user_code_idx
  ON terminal_auth_requests (user_code)
  WHERE consumed_at IS NULL;
