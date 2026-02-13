-- Migration: Add atomic lock index to prevent race conditions
-- Purpose: Ensures only ONE process can hold a "started" lock for each operation_key
-- Date: 2026-02-02
--
-- PROBLEM THIS SOLVES:
-- If two bot instances run simultaneously (npm start + PM2), both could:
--   1. Check canBroadcast() → both see no record → both return PASS
--   2. Both call markBroadcastStarted() → both INSERT → BOTH SEND MESSAGES = SPAM
--
-- SOLUTION:
-- A partial unique index that only allows ONE record with status='started' per operation_key
-- When two processes try to INSERT at the exact same time:
--   - First one succeeds (gets the lock)
--   - Second one fails with unique constraint violation (blocked)

-- Drop the old constraint that allowed multiple 'started' records
-- (The old UNIQUE(operation_key, run_id) allowed both processes to insert with different run_ids)
ALTER TABLE broadcast_guard DROP CONSTRAINT IF EXISTS broadcast_guard_operation_key_run_id_key;

-- Create partial unique index: only ONE 'started' record per operation_key
-- This is the ATOMIC LOCK that prevents race conditions
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_guard_active_lock
ON broadcast_guard(operation_key)
WHERE status = 'started';

-- Keep the original compound unique for data integrity (prevents truly duplicate records)
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_guard_unique_run
ON broadcast_guard(operation_key, run_id);

-- Explanation:
-- idx_broadcast_guard_active_lock: Prevents two processes from both having 'started' status
-- idx_broadcast_guard_unique_run: Prevents duplicate records (same operation_key + run_id)
--
-- Flow with fix:
-- Process A: canBroadcast() → PASS
-- Process B: canBroadcast() → PASS (race condition still here)
-- Process A: INSERT status='started' → SUCCESS (gets lock)
-- Process B: INSERT status='started' → FAIL (unique violation) → BLOCKED!
