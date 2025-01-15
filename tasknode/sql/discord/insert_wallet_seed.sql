INSERT INTO user_wallet_seeds 
    (discord_user_id, wallet_label, encrypted_seed, is_active)
VALUES 
    ($1, $2, $3, false)
RETURNING id;