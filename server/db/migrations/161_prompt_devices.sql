CREATE TABLE prompt_devices (
  device_id uuid PRIMARY KEY,
  account_id text NOT NULL,
  session_id text NOT NULL,
  public_key text NOT NULL,
  fingerprint text NOT NULL,
  label text NOT NULL,
  encrypted_key_envelope jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  revoked_at timestamptz,
  UNIQUE(session_id)
);
CREATE INDEX prompt_devices_account ON prompt_devices(account_id, created_at);
