SELECT wallet_label, is_active, encrypted_seed
FROM user_wallet_seeds
WHERE discord_user_id = $1
ORDER BY last_used_at DESC;