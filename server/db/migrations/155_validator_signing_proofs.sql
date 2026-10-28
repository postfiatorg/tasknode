-- Public verification evidence only. No validator token or private key.
ALTER TABLE validator_bindings ADD COLUMN signing_public_key text;
ALTER TABLE validator_bindings ADD COLUMN manifest text;
-- Preserve every reconnect proof without replacing the original binding.
ALTER TABLE validator_connect_tokens ADD COLUMN proof jsonb;
