-- Repair the generated product title, including drafts already in progress.
-- The art prompt/version stays separate from the profile picture's name.
-- Preserve custom titles and existing pinned/on-chain metadata.
UPDATE profile_nfts
SET title = 'Profile Pic NFT',
    description = CASE
      WHEN description = 'An original Techno Mordor ink portrait of demonstrated work. The art guide and anonymous art traits are public; task history stays private.'
      THEN 'An original ink profile picture inspired by completed work. The art guide and anonymous art traits are public; task history stays private.'
      ELSE description
    END
WHERE prompt_source = 'techno-mordor-v2' AND title = 'Techno Mordor';
