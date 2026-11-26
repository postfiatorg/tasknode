-- Independently encrypted files let the gated viewer read one asset without
-- fetching/decrypting the full archive. The archive remains for older clients.
CREATE TABLE index_viewer_bundle_files (
  index_id text NOT NULL REFERENCES index_viewer_indices(index_id) ON DELETE CASCADE,
  bundle_hash text NOT NULL,
  file_path text NOT NULL,
  file_hash text NOT NULL,
  encrypted_bytes bytea NOT NULL,
  PRIMARY KEY (index_id, bundle_hash, file_path)
);
