SELECT * 
FROM user_wallet_seeds 
WHERE discord_user_id = $1 AND is_active = true
LIMIT 1;