ALTER TABLE chat_model_runs
  ADD COLUMN IF NOT EXISTS provider_cost_usd numeric(18, 6);

ALTER TABLE billing_ledger_entries
  ADD COLUMN IF NOT EXISTS provider_cost_usd numeric(18, 6);
