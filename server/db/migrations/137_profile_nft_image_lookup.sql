CREATE INDEX IF NOT EXISTS profile_nfts_image_cid_idx
 ON profile_nfts (image_cid) WHERE image_cid <> '';
