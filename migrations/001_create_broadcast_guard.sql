-- Migration: Create broadcast_guard table
-- Purpose: Atomic protection against duplicate broadcast messages (daily summaries, Shabbat locks)
-- Date: 2026-02-02

-- Create the broadcast_guard table
CREATE TABLE IF NOT EXISTS broadcast_guard (
  id SERIAL PRIMARY KEY,
  operation_key TEXT NOT NULL,          -- Unique key like "daily-summary-2024-02-02"
  broadcast_type TEXT NOT NULL,         -- Type: daily-summary, shabbat-lock, shabbat-unlock, erev-shabbat-summary
  status TEXT NOT NULL DEFAULT 'started', -- started, completed, failed
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  run_id TEXT NOT NULL,                 -- Unique ID for this specific run
  groups_sent TEXT[] DEFAULT '{}',      -- List of group IDs that received the message
  error_message TEXT,
  UNIQUE(operation_key, run_id)
);

-- Indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_broadcast_guard_key ON broadcast_guard(operation_key);
CREATE INDEX IF NOT EXISTS idx_broadcast_guard_type ON broadcast_guard(broadcast_type);
CREATE INDEX IF NOT EXISTS idx_broadcast_guard_status ON broadcast_guard(status);

-- Comment on table
COMMENT ON TABLE broadcast_guard IS 'Atomic protection against duplicate broadcast messages even with rapid reconnections';

-- Comment on columns
COMMENT ON COLUMN broadcast_guard.operation_key IS 'Unique key combining broadcast type and date, e.g. daily-summary-2024-02-02';
COMMENT ON COLUMN broadcast_guard.broadcast_type IS 'Type of broadcast: daily-summary, shabbat-lock, shabbat-unlock, erev-shabbat-summary';
COMMENT ON COLUMN broadcast_guard.status IS 'Current status: started (running), completed (success), failed (error)';
COMMENT ON COLUMN broadcast_guard.run_id IS 'Unique identifier for this run, used to distinguish multiple attempts';
COMMENT ON COLUMN broadcast_guard.groups_sent IS 'Array of group IDs that have received this broadcast, for partial recovery';
