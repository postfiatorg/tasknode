-- Finance Hub model agent: an allowlisted operator chats with a DeepSeek agent about one company model.
-- The agent runs on the model host (it pulls work with a service token); it reads a sealed copy of the model and can
-- propose a change, which applies only after the operator approves it.
CREATE TABLE finance_agent_threads (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  model text NOT NULL,
  title text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX finance_agent_threads_account_model ON finance_agent_threads(account_id, model, updated_at DESC);

CREATE TABLE finance_agent_messages (
  id text PRIMARY KEY,
  thread_id text NOT NULL REFERENCES finance_agent_threads(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'agent')),
  content text NOT NULL DEFAULT '',
  context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'done' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  progress text NOT NULL DEFAULT '',
  reply_to text,
  cost_usd numeric(12,6),
  meta_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX finance_agent_messages_thread ON finance_agent_messages(thread_id, created_at);
CREATE INDEX finance_agent_messages_queue ON finance_agent_messages(created_at)
  WHERE role = 'agent' AND status IN ('queued', 'running');

CREATE TABLE finance_agent_proposals (
  id text PRIMARY KEY,
  thread_id text NOT NULL REFERENCES finance_agent_threads(id) ON DELETE CASCADE,
  message_id text NOT NULL REFERENCES finance_agent_messages(id) ON DELETE CASCADE,
  model text NOT NULL,
  payload_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'applying', 'applied', 'failed')),
  decided_by text,
  decided_at timestamptz,
  claimed_at timestamptz,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX finance_agent_proposals_thread ON finance_agent_proposals(thread_id, created_at);
CREATE INDEX finance_agent_proposals_queue ON finance_agent_proposals(decided_at) WHERE status IN ('approved', 'applying');
