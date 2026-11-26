-- Only ciphertext is stored here. Plaintext model/research files are never in git.
CREATE TABLE index_viewer_bundles (
  index_id text PRIMARY KEY REFERENCES index_viewer_indices(index_id),
  encrypted_bytes bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
