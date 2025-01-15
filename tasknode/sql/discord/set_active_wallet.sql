WITH updated AS (
    UPDATE user_wallet_seeds 
    SET is_active = false 
    WHERE discord_user_id = $1
)
UPDATE user_wallet_seeds 
SET is_active = true, last_used_at = CURRENT_TIMESTAMP
WHERE discord_user_id = $1 AND wallet_label = $2
RETURNING id;