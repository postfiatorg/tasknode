UPDATE user_wallet_seeds 
SET encrypted_seed = $3 
WHERE discord_user_id = $1 
  AND wallet_label = $2;