-- The current decision of the uptime feed, kept apart from the last good data.
--
-- l1_validator_access and l1_uptime_feed_observers hold what the last feed
-- that verified said. This row holds what the latest read decided, good or
-- bad. New bindings and new credit follow this row: a read that came back
-- indeterminate, rejected or unreachable stops them at once, while existing
-- access stays as it was.
CREATE TABLE l1_uptime_feed_state (
  keyset_id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('applied', 'indeterminate', 'feed_rejected', 'feed_unavailable')),
  reason text,
  decided_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
