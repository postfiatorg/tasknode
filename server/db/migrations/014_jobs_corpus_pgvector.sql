CREATE TABLE IF NOT EXISTS jobs_corpus_sources (
  id text PRIMARY KEY,
  source_url text NOT NULL,
  raw_sha256 text NOT NULL UNIQUE,
  raw_size_bytes integer NOT NULL CHECK (raw_size_bytes >= 0),
  source_label text NOT NULL DEFAULT 'Jobs corpus',
  fetched_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'pgvector extension is not installed and this database user cannot create it; Jobs retrieval will stay disabled until an operator provisions pgvector.';
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE $jobs_chunks$
      CREATE TABLE IF NOT EXISTS jobs_corpus_chunks (
        id text PRIMARY KEY,
        source_id text NOT NULL REFERENCES jobs_corpus_sources(id) ON DELETE CASCADE,
        chunk_index integer NOT NULL CHECK (chunk_index >= 0),
        packet_label text NOT NULL DEFAULT '',
        title text NOT NULL DEFAULT '',
        content text NOT NULL,
        content_sha256 text NOT NULL,
        token_estimate integer NOT NULL DEFAULT 0 CHECK (token_estimate >= 0),
        embedding_model text NOT NULL,
        embedding_dimensions integer NOT NULL DEFAULT 1536 CHECK (embedding_dimensions = 1536),
        embedding_provider text NOT NULL DEFAULT 'openai',
        embedding vector(1536) NOT NULL,
        metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (source_id, embedding_model, embedding_dimensions, chunk_index),
        UNIQUE (source_id, embedding_model, embedding_dimensions, content_sha256)
      )
    $jobs_chunks$;

    CREATE INDEX IF NOT EXISTS idx_jobs_corpus_chunks_source_model
      ON jobs_corpus_chunks (source_id, embedding_model, embedding_dimensions, chunk_index);

    CREATE INDEX IF NOT EXISTS idx_jobs_corpus_chunks_content_sha
      ON jobs_corpus_chunks (content_sha256);
  END IF;
END $$;
