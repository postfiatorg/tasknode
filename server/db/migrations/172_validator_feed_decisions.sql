CREATE TABLE l1_feed_decisions (
  network text NOT NULL, chain_id text NOT NULL, keyset_id text NOT NULL,
  poll_id uuid NOT NULL, status text NOT NULL, accepted jsonb NOT NULL,
  PRIMARY KEY(network,chain_id)
);
ALTER TABLE l1_validator_access ADD COLUMN poll_id uuid;

-- An existing billing account is the operator identity shared by both reward paths.
CREATE TABLE validator_operator_reward_months (
  account_id text NOT NULL, reward_month text NOT NULL, PRIMARY KEY(account_id,reward_month)
);
INSERT INTO validator_operator_reward_months
  SELECT account_id,reward_month FROM validator_reward_grants UNION
  SELECT account_id,reward_month FROM l1_validator_reward_grants;

CREATE FUNCTION reserve_validator_operator_month() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO validator_operator_reward_months VALUES (NEW.account_id,NEW.reward_month)
    ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='PV001', MESSAGE='validator operator month already paid';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER claim_operator_month AFTER INSERT ON validator_reward_grants
  FOR EACH ROW EXECUTE FUNCTION reserve_validator_operator_month();
CREATE TRIGGER claim_operator_month AFTER INSERT ON l1_validator_reward_grants
  FOR EACH ROW EXECUTE FUNCTION reserve_validator_operator_month();
