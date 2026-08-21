CREATE TABLE IF NOT EXISTS i_ching_profiles (
  account_id text PRIMARY KEY,
  birth_date date NOT NULL,
  birth_time text NOT NULL,
  birth_location text NOT NULL,
  gender text NOT NULL,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  timezone text NOT NULL,
  true_solar_time text NOT NULL,
  true_solar_offset_minutes integer NOT NULL,
  bazi_json jsonb NOT NULL,
  ziwei_json jsonb NOT NULL,
  combined_json jsonb NOT NULL,
  chart_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS i_ching_profiles_updated_idx
  ON i_ching_profiles (updated_at DESC, account_id);
