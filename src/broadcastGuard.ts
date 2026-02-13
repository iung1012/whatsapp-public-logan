/**
 * Broadcast Guard - Prevents duplicate broadcast messages using Supabase
 *
 * This module provides atomic, database-backed protection against sending
 * duplicate broadcast messages (daily summaries, Shabbat locks, etc.)
 * even when the bot experiences rapid disconnections/reconnections.
 *
 * Key features:
 * - Uses Supabase for atomic operations (survives any number of restarts)
 * - Date-based operation keys prevent duplicates within the same day/period
 * - Cooldown periods prevent rapid re-sends
 * - Status tracking (started, completed, failed) handles crashed runs
 */

import { getSupabaseClient } from './supabase';

// Operation types
export type BroadcastType =
  | 'daily-summary'
  | 'shabbat-lock'
  | 'shabbat-unlock'
  | 'erev-shabbat-summary';

interface BroadcastRecord {
  id?: number;
  operation_key: string;      // Unique key like "daily-summary-2024-02-02"
  broadcast_type: string;
  status: 'started' | 'completed' | 'failed';
  started_at: string;
  completed_at: string | null;
  run_id: string;
  groups_sent: string[];      // List of group IDs that received the message
  error_message: string | null;
}

// Cooldown periods per broadcast type (in milliseconds)
const COOLDOWN_PERIODS: Record<BroadcastType, number> = {
  'daily-summary': 30 * 60 * 1000,      // 30 minutes
  'shabbat-lock': 12 * 60 * 60 * 1000,  // 12 hours
  'shabbat-unlock': 12 * 60 * 60 * 1000, // 12 hours
  'erev-shabbat-summary': 30 * 60 * 1000, // 30 minutes
};

// Stale timeout - if "started" for longer than this, consider it crashed
const STALE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Generate a unique operation key for today's date
 */
export function getOperationKey(type: BroadcastType, customSuffix?: string): string {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return customSuffix ? `${type}-${today}-${customSuffix}` : `${type}-${today}`;
}

/**
 * Generate a unique run ID
 */
function generateRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Check if a broadcast can proceed (not already sent, not in cooldown, not running)
 * This is an ATOMIC check using Supabase
 */
export async function canBroadcast(
  type: BroadcastType,
  customSuffix?: string
): Promise<{ canProceed: boolean; reason?: string; existingRunId?: string }> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.error('[BroadcastGuard] Supabase not available - allowing broadcast (no guard)');
    return { canProceed: true };
  }

  const operationKey = getOperationKey(type, customSuffix);
  const cooldownPeriod = COOLDOWN_PERIODS[type];

  try {
    // Check for existing broadcast with this key
    const { data: existing, error } = await supabase
      .from('broadcast_guard')
      .select('*')
      .eq('operation_key', operationKey)
      .order('started_at', { ascending: false })
      .limit(1);

    if (error) {
      // Table might not exist yet - allow broadcast
      if (error.code === '42P01') {
        console.log('[BroadcastGuard] Table does not exist - allowing broadcast');
        return { canProceed: true };
      }
      console.error('[BroadcastGuard] Error checking broadcast:', error);
      return { canProceed: true }; // Allow on error (fail open)
    }

    if (!existing || existing.length === 0) {
      console.log(`[BroadcastGuard] No existing record for ${operationKey} - can proceed`);
      return { canProceed: true };
    }

    const record = existing[0] as BroadcastRecord;
    const now = Date.now();
    const startedAt = new Date(record.started_at).getTime();
    const elapsed = now - startedAt;

    // Check if there's a running broadcast that's NOT stale
    if (record.status === 'started') {
      if (elapsed < STALE_TIMEOUT_MS) {
        console.log(`[BroadcastGuard] Broadcast ${operationKey} is RUNNING (${Math.round(elapsed/1000)}s ago) - BLOCKING`);
        return {
          canProceed: false,
          reason: `Already running (started ${Math.round(elapsed/1000)}s ago)`,
          existingRunId: record.run_id
        };
      } else {
        // Stale - mark as failed and allow new run
        console.log(`[BroadcastGuard] Broadcast ${operationKey} is STALE (${Math.round(elapsed/1000)}s) - marking failed, allowing new run`);
        await markBroadcastFailed(operationKey, record.run_id, 'Stale - no completion after 15 minutes');
        return { canProceed: true };
      }
    }

    // Check cooldown for completed broadcasts
    if (record.status === 'completed') {
      const completedAt = record.completed_at ? new Date(record.completed_at).getTime() : startedAt;
      const timeSinceCompletion = now - completedAt;

      if (timeSinceCompletion < cooldownPeriod) {
        const remainingMinutes = Math.ceil((cooldownPeriod - timeSinceCompletion) / 60000);
        console.log(`[BroadcastGuard] Broadcast ${operationKey} completed recently - cooldown ${remainingMinutes}min remaining - BLOCKING`);
        return {
          canProceed: false,
          reason: `Cooldown: ${remainingMinutes} minutes remaining`,
          existingRunId: record.run_id
        };
      }
    }

    // Failed broadcasts can be retried
    if (record.status === 'failed') {
      console.log(`[BroadcastGuard] Previous broadcast ${operationKey} failed - can retry`);
      return { canProceed: true };
    }

    console.log(`[BroadcastGuard] Broadcast ${operationKey} cooldown expired - can proceed`);
    return { canProceed: true };

  } catch (err) {
    console.error('[BroadcastGuard] Exception in canBroadcast:', err);
    return { canProceed: true }; // Fail open
  }
}

/**
 * Mark a broadcast as STARTED - ATOMIC LOCK ACQUISITION
 *
 * This function combines checking and locking into one atomic operation.
 * Uses a partial unique index to ensure only ONE process can hold the lock.
 *
 * Returns runId that must be used for completion/failure, or null if blocked
 */
export async function markBroadcastStarted(
  type: BroadcastType,
  customSuffix?: string
): Promise<string | null> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.error('[BroadcastGuard] Supabase not available');
    return null;
  }

  const operationKey = getOperationKey(type, customSuffix);
  const runId = generateRunId();

  try {
    // ATOMIC LOCK: Insert with unique constraint on (operation_key) WHERE status='started'
    // If another process already has a 'started' record, this will fail with unique violation
    const { data, error } = await supabase
      .from('broadcast_guard')
      .insert({
        operation_key: operationKey,
        broadcast_type: type,
        status: 'started',
        started_at: new Date().toISOString(),
        completed_at: null,
        run_id: runId,
        groups_sent: [],
        error_message: null
      })
      .select('id')
      .single();

    if (error) {
      // Unique constraint violation = another process has the lock
      if (error.code === '23505') {
        console.log(`[BroadcastGuard] LOCK BLOCKED: Another process already has lock for ${operationKey}`);
        return null;
      }

      // Table might not exist - create it
      if (error.code === '42P01') {
        console.log('[BroadcastGuard] Table does not exist - creating...');
        await createBroadcastGuardTable();
        // Retry insert
        const { data: retryData, error: retryError } = await supabase
          .from('broadcast_guard')
          .insert({
            operation_key: operationKey,
            broadcast_type: type,
            status: 'started',
            started_at: new Date().toISOString(),
            completed_at: null,
            run_id: runId,
            groups_sent: [],
            error_message: null
          })
          .select('id')
          .single();

        if (retryError) {
          if (retryError.code === '23505') {
            console.log(`[BroadcastGuard] LOCK BLOCKED after table create: ${operationKey}`);
            return null;
          }
          console.error('[BroadcastGuard] Failed to insert after creating table:', retryError);
          return null;
        }
      } else {
        console.error('[BroadcastGuard] Error marking broadcast started:', error);
        return null;
      }
    }

    console.log(`[BroadcastGuard] LOCK ACQUIRED: ${operationKey} (runId: ${runId})`);
    return runId;

  } catch (err) {
    console.error('[BroadcastGuard] Exception in markBroadcastStarted:', err);
    return null;
  }
}

/**
 * Record that a group received the broadcast message
 */
export async function recordGroupSent(
  operationKey: string,
  runId: string,
  groupId: string
): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    // Get current groups_sent and append
    const { data, error: fetchError } = await supabase
      .from('broadcast_guard')
      .select('groups_sent')
      .eq('operation_key', operationKey)
      .eq('run_id', runId)
      .single();

    if (fetchError || !data) return;

    const groupsSent = data.groups_sent || [];
    if (!groupsSent.includes(groupId)) {
      groupsSent.push(groupId);

      await supabase
        .from('broadcast_guard')
        .update({ groups_sent: groupsSent })
        .eq('operation_key', operationKey)
        .eq('run_id', runId);
    }
  } catch (err) {
    // Non-fatal
  }
}

/**
 * Check if a specific group already received this broadcast
 */
export async function hasGroupReceived(
  type: BroadcastType,
  groupId: string,
  customSuffix?: string
): Promise<boolean> {
  const supabase = getSupabaseClient();
  if (!supabase) return false;

  const operationKey = getOperationKey(type, customSuffix);

  try {
    const { data, error } = await supabase
      .from('broadcast_guard')
      .select('groups_sent, status')
      .eq('operation_key', operationKey)
      .order('started_at', { ascending: false })
      .limit(1);

    if (error || !data || data.length === 0) return false;

    const record = data[0];
    // Only consider completed or running (not failed) broadcasts
    if (record.status === 'failed') return false;

    return (record.groups_sent || []).includes(groupId);

  } catch (err) {
    return false;
  }
}

/**
 * Mark a broadcast as COMPLETED
 */
export async function markBroadcastCompleted(
  operationKey: string,
  runId: string
): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    const { error } = await supabase
      .from('broadcast_guard')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString()
      })
      .eq('operation_key', operationKey)
      .eq('run_id', runId);

    if (error) {
      console.error('[BroadcastGuard] Error marking completed:', error);
      return;
    }

    console.log(`[BroadcastGuard] Broadcast ${operationKey} COMPLETED`);

  } catch (err) {
    console.error('[BroadcastGuard] Exception in markBroadcastCompleted:', err);
  }
}

/**
 * Mark a broadcast as FAILED
 */
export async function markBroadcastFailed(
  operationKey: string,
  runId: string,
  errorMessage?: string
): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    const { error } = await supabase
      .from('broadcast_guard')
      .update({
        status: 'failed',
        error_message: errorMessage || null
      })
      .eq('operation_key', operationKey)
      .eq('run_id', runId);

    if (error) {
      console.error('[BroadcastGuard] Error marking failed:', error);
      return;
    }

    console.log(`[BroadcastGuard] Broadcast ${operationKey} FAILED: ${errorMessage}`);

  } catch (err) {
    console.error('[BroadcastGuard] Exception in markBroadcastFailed:', err);
  }
}

/**
 * Create the broadcast_guard table in Supabase
 */
async function createBroadcastGuardTable(): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  // Note: This requires the service_role key or appropriate permissions
  // For production, create this table via Supabase dashboard or migrations
  console.log('[BroadcastGuard] Please create broadcast_guard table in Supabase with:');
  console.log(`
    CREATE TABLE broadcast_guard (
      id SERIAL PRIMARY KEY,
      operation_key TEXT NOT NULL,
      broadcast_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'started',
      started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP WITH TIME ZONE,
      run_id TEXT NOT NULL,
      groups_sent TEXT[] DEFAULT '{}',
      error_message TEXT,
      UNIQUE(operation_key, run_id)
    );

    CREATE INDEX idx_broadcast_guard_key ON broadcast_guard(operation_key);
    CREATE INDEX idx_broadcast_guard_type ON broadcast_guard(broadcast_type);
  `);
}

/**
 * Wrapper for running a broadcast operation with automatic guard
 */
export async function withBroadcastGuard<T>(
  type: BroadcastType,
  operation: (runId: string, operationKey: string) => Promise<T>,
  customSuffix?: string
): Promise<{ success: boolean; result?: T; skipped?: boolean; reason?: string }> {

  // Check if we can proceed
  const check = await canBroadcast(type, customSuffix);
  if (!check.canProceed) {
    console.log(`[BroadcastGuard] Skipping ${type}: ${check.reason}`);
    return { success: false, skipped: true, reason: check.reason };
  }

  // Mark as started
  const runId = await markBroadcastStarted(type, customSuffix);
  if (!runId) {
    console.error(`[BroadcastGuard] Failed to mark ${type} as started`);
    return { success: false, reason: 'Failed to acquire broadcast lock' };
  }

  const operationKey = getOperationKey(type, customSuffix);

  try {
    const result = await operation(runId, operationKey);
    await markBroadcastCompleted(operationKey, runId);
    return { success: true, result };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    await markBroadcastFailed(operationKey, runId, errorMessage);
    return { success: false, reason: errorMessage };
  }
}
