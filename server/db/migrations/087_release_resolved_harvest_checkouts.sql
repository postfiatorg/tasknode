UPDATE task_accounting_harvests
SET checked_out_at = NULL,
    checked_out_by_account_id = '',
    checked_out_wallet_address = '',
    updated_at = now()
WHERE resolved_at IS NOT NULL
  AND checked_out_at IS NOT NULL;
