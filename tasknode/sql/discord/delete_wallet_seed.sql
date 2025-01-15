DELETE FROM user_wallet_seeds 
WHERE discord_user_id = $1 AND wallet_label = $2
RETURNING id;