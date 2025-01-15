SELECT COUNT(*) as count
FROM user_wallet_seeds
WHERE discord_user_id = $1;