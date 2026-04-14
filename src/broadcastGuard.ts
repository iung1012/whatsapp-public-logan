/**
 * Broadcast Guard - Prevents duplicate broadcast messages using PostgreSQL
 *
 * Provides atomic, database-backed protection against sending duplicate broadcast
 * messages even when the bot experiences rapid disconnections/reconnections.
 */

import { getDb } from './db';

export type BroadcastType =
  | 'daily-summary'
  | 'shabbat-lock'
  | 'shabbat-unlock'
  | 'erev-shabbat-summary';

interface BroadcastRecord {
  id?: number;
  operation_key: string;
  broadcast_type: string;
  status: 'started' | 'completed' | 'failed';
  started_at: string;
  completed_at: string | null;
  run_id: string;
  groups_sent: string[];
  error_message: string | null;
}

const COOLDOWN_PERIODS: Record<BroadcastType, number> = {
  'daily-summary':        30 * 60 * 1000,
  'shabbat-lock':         12 * 60 * 60 * 1000,
  'shabbat-unlock':       12 * 60 * 60 * 1000,
  'erev-shabbat-summary': 30 * 60 * 1000,
};

const STALE_TIMEOUT_MS = 15 * 60 * 1000;

export function getOperationKey(type: BroadcastType, customSuffix?: string): string {
  const today = new Date().toISOString().split('T')[0];
  return customSuffix ? `${type}-${today}-${customSuffix}` : `${type}-${today}`;
}

function generateRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export async function canBroadcast(
  type: BroadcastType,
  customSuffix?: string
): Promise<{ canProceed: boolean; reason?: string; existingRunId?: string }> {
  const operationKey = getOperationKey(type, customSuffix);
  const cooldownPeriod = COOLDOWN_PERIODS[type];

  try {
    const sql = getDb();
    const rows = await sql<BroadcastRecord[]>`
      SELECT *
      FROM broadcast_guard
      WHERE operation_key = ${operationKey}
      ORDER BY started_at DESC
      LIMIT 1
    `;

    if (rows.length === 0) {
      console.log(`[BroadcastGuard] No existing record for ${operationKey} - can proceed`);
      return { canProceed: true };
    }

    const record = rows[0];
    const now = Date.now();
    const startedAt = new Date(record.started_at).getTime();
    const elapsed = now - startedAt;

    if (record.status === 'started') {
      if (elapsed < STALE_TIMEOUT_MS) {
        console.log(`[BroadcastGuard] Broadcast ${operationKey} is RUNNING (${Math.round(elapsed / 1000)}s ago) - BLOCKING`);
        return { canProceed: false, reason: `Already running (started ${Math.round(elapsed / 1000)}s ago)`, existingRunId: record.run_id };
      } else {
        console.log(`[BroadcastGuard] Broadcast ${operationKey} is STALE (${Math.round(elapsed / 1000)}s) - marking failed`);
        await markBroadcastFailed(operationKey, record.run_id, 'Stale - no completion after 15 minutes');
        return { canProceed: true };
      }
    }

    if (record.status === 'completed') {
      const completedAt = record.completed_at ? new Date(record.completed_at).getTime() : startedAt;
      const timeSinceCompletion = now - completedAt;
      if (timeSinceCompletion < cooldownPeriod) {
        const remainingMinutes = Math.ceil((cooldownPeriod - timeSinceCompletion) / 60000);
        console.log(`[BroadcastGuard] Broadcast ${operationKey} in cooldown - ${remainingMinutes}min remaining - BLOCKING`);
        return { canProceed: false, reason: `Cooldown: ${remainingMinutes} minutes remaining`, existingRunId: record.run_id };
      }
    }

    if (record.status === 'failed') {
      console.log(`[BroadcastGuard] Previous broadcast ${operationKey} failed - can retry`);
      return { canProceed: true };
    }

    console.log(`[BroadcastGuard] Broadcast ${operationKey} cooldown expired - can proceed`);
    return { canProceed: true };

  } catch (err: any) {
    if (err.code === '42P01') {
      console.log('[BroadcastGuard] Table does not exist - allowing broadcast');
      return { canProceed: true };
    }
    console.error('[BroadcastGuard] Exception in canBroadcast:', err);
    return { canProceed: true };
  }
}

export async function markBroadcastStarted(
  type: BroadcastType,
  customSuffix?: string
): Promise<string | null> {
  const operationKey = getOperationKey(type, customSuffix);
  const runId = generateRunId();

  try {
    const sql = getDb();
    await sql`
      INSERT INTO broadcast_guard (operation_key, broadcast_type, status, started_at, completed_at, run_id, groups_sent, error_message)
      VALUES (${operationKey}, ${type}, 'started', NOW(), NULL, ${runId}, ARRAY[]::TEXT[], NULL)
    `;
    console.log(`[BroadcastGuard] LOCK ACQUIRED: ${operationKey} (runId: ${runId})`);
    return runId;

  } catch (err: any) {
    if (err.code === '23505') {
      console.log(`[BroadcastGuard] LOCK BLOCKED: Another process already has lock for ${operationKey}`);
      return null;
    }
    console.error('[BroadcastGuard] Error marking broadcast started:', err);
    return null;
  }
}

export async function recordGroupSent(
  operationKey: string,
  runId: string,
  groupId: string
): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      UPDATE broadcast_guard
      SET groups_sent = array_append(groups_sent, ${groupId})
      WHERE operation_key = ${operationKey}
        AND run_id = ${runId}
        AND NOT (${groupId} = ANY(groups_sent))
    `;
  } catch (err) {
    // Non-fatal
  }
}

export async function hasGroupReceived(
  type: BroadcastType,
  groupId: string,
  customSuffix?: string
): Promise<boolean> {
  const operationKey = getOperationKey(type, customSuffix);

  try {
    const sql = getDb();
    const rows = await sql<{ groups_sent: string[]; status: string }[]>`
      SELECT groups_sent, status
      FROM broadcast_guard
      WHERE operation_key = ${operationKey}
      ORDER BY started_at DESC
      LIMIT 1
    `;

    if (rows.length === 0) return false;
    const record = rows[0];
    if (record.status === 'failed') return false;
    return (record.groups_sent || []).includes(groupId);

  } catch (err) {
    return false;
  }
}

export async function markBroadcastCompleted(
  operationKey: string,
  runId: string
): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      UPDATE broadcast_guard
      SET status = 'completed', completed_at = NOW()
      WHERE operation_key = ${operationKey} AND run_id = ${runId}
    `;
    console.log(`[BroadcastGuard] Broadcast ${operationKey} COMPLETED`);
  } catch (err) {
    console.error('[BroadcastGuard] Exception in markBroadcastCompleted:', err);
  }
}

export async function markBroadcastFailed(
  operationKey: string,
  runId: string,
  errorMessage?: string
): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      UPDATE broadcast_guard
      SET status = 'failed', error_message = ${errorMessage ?? null}
      WHERE operation_key = ${operationKey} AND run_id = ${runId}
    `;
    console.log(`[BroadcastGuard] Broadcast ${operationKey} FAILED: ${errorMessage}`);
  } catch (err) {
    console.error('[BroadcastGuard] Exception in markBroadcastFailed:', err);
  }
}

export async function withBroadcastGuard<T>(
  type: BroadcastType,
  operation: (runId: string, operationKey: string) => Promise<T>,
  customSuffix?: string
): Promise<{ success: boolean; result?: T; skipped?: boolean; reason?: string }> {

  const check = await canBroadcast(type, customSuffix);
  if (!check.canProceed) {
    console.log(`[BroadcastGuard] Skipping ${type}: ${check.reason}`);
    return { success: false, skipped: true, reason: check.reason };
  }

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
