CREATE TABLE IF NOT EXISTS user_wallet_seeds (
    id SERIAL PRIMARY KEY,
    discord_user_id BIGINT NOT NULL,
    wallet_label VARCHAR(100) NOT NULL,
    encrypted_seed TEXT NOT NULL,
    is_active BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_label_per_user UNIQUE (discord_user_id, wallet_label)
);