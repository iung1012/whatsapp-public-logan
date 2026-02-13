-- Migration: Create pending_responses table
-- Purpose: Store landing page URLs and other responses that couldn't be delivered
--          due to WhatsApp connection issues. Will be delivered when connection is restored.

CREATE TABLE IF NOT EXISTS pending_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id TEXT NOT NULL,
  sender_number TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  response TEXT NOT NULL,
  response_type TEXT NOT NULL CHECK (response_type IN ('landing_page', 'video', 'agent')),
  retry_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for efficient retrieval of pending responses
CREATE INDEX IF NOT EXISTS idx_pending_responses_created_at
  ON pending_responses(created_at ASC);

-- Index for filtering by group
CREATE INDEX IF NOT EXISTS idx_pending_responses_group_id
  ON pending_responses(group_id);

-- Comment explaining the table purpose
COMMENT ON TABLE pending_responses IS 'Stores responses that could not be delivered due to WhatsApp connection issues. Processed automatically when connection is restored.';
