DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'pgvector extension is not installed and this database user cannot create it; recommended connections stay disabled until an operator provisions pgvector.';
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE $recommended_connection_profiles$
      CREATE TABLE IF NOT EXISTS recommended_connection_profiles (
        account_id text PRIMARY KEY,
        wallet_address text NOT NULL DEFAULT '',
        display_name text NOT NULL DEFAULT '',
        hive_handle text NOT NULL DEFAULT '',
        visibility text NOT NULL DEFAULT 'public',
        discoverable boolean NOT NULL DEFAULT true,
        packet_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        packet_text text NOT NULL DEFAULT '',
        packet_digest text NOT NULL DEFAULT '',
        network_profile_id text NOT NULL DEFAULT '',
        network_profile_digest text NOT NULL DEFAULT '',
        embedding_model text NOT NULL,
        embedding_dimensions integer NOT NULL DEFAULT 1536 CHECK (embedding_dimensions = 1536),
        embedding_provider text NOT NULL DEFAULT 'openai',
        embedding vector(1536) NOT NULL,
        generated_at timestamptz NOT NULL DEFAULT now(),
        disabled_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    $recommended_connection_profiles$;

    CREATE INDEX IF NOT EXISTS recommended_connection_profiles_discoverable_idx
      ON recommended_connection_profiles (discoverable, visibility, disabled_at, generated_at DESC);

    CREATE INDEX IF NOT EXISTS recommended_connection_profiles_model_idx
      ON recommended_connection_profiles (embedding_model, embedding_dimensions, updated_at DESC);

    EXECUTE $recommended_connection_runs$
      CREATE TABLE IF NOT EXISTS recommended_connection_runs (
        id text PRIMARY KEY,
        target_account_id text NOT NULL,
        status text NOT NULL DEFAULT 'processing',
        trigger text NOT NULL DEFAULT '',
        target_packet_digest text NOT NULL DEFAULT '',
        candidate_count integer NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
        candidate_profile_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        provider text NOT NULL DEFAULT '',
        model text NOT NULL DEFAULT '',
        prompt_version text NOT NULL DEFAULT 'recommended_connections_v1',
        prompt_digest text NOT NULL DEFAULT '',
        output_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        usage_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        last_error text NOT NULL DEFAULT '',
        started_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT recommended_connection_runs_status_chk
          CHECK (status IN ('processing', 'completed', 'failed', 'skipped'))
      )
    $recommended_connection_runs$;

    CREATE INDEX IF NOT EXISTS recommended_connection_runs_target_recent_idx
      ON recommended_connection_runs (target_account_id, completed_at DESC NULLS LAST, created_at DESC, id);

    EXECUTE $recommended_connections$
      CREATE TABLE IF NOT EXISTS recommended_connections (
        id text PRIMARY KEY,
        run_id text NOT NULL REFERENCES recommended_connection_runs(id) ON DELETE CASCADE,
        target_account_id text NOT NULL,
        candidate_account_id text NOT NULL,
        rank integer NOT NULL CHECK (rank >= 1),
        reason text NOT NULL DEFAULT '',
        suggested_first_action text NOT NULL DEFAULT '',
        shared_context text NOT NULL DEFAULT '',
        complementary_value text NOT NULL DEFAULT '',
        risk_or_uncertainty text NOT NULL DEFAULT '',
        supporting_signals jsonb NOT NULL DEFAULT '[]'::jsonb,
        candidate_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
        score numeric(10, 6) NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'active',
        expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (run_id, rank),
        UNIQUE (run_id, candidate_account_id)
      )
    $recommended_connections$;

    CREATE INDEX IF NOT EXISTS recommended_connections_target_active_idx
      ON recommended_connections (target_account_id, status, expires_at DESC, rank, id);

    CREATE INDEX IF NOT EXISTS recommended_connections_candidate_idx
      ON recommended_connections (candidate_account_id, status, updated_at DESC);

    EXECUTE $recommended_connection_events$
      CREATE TABLE IF NOT EXISTS recommended_connection_events (
        id text PRIMARY KEY,
        target_account_id text NOT NULL,
        candidate_account_id text NOT NULL,
        connection_id text NOT NULL DEFAULT '',
        event_type text NOT NULL,
        metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    $recommended_connection_events$;

    CREATE INDEX IF NOT EXISTS recommended_connection_events_target_recent_idx
      ON recommended_connection_events (target_account_id, created_at DESC, id);
  END IF;
END $$;
