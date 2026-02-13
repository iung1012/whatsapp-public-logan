/**
 * Join Request Scheduler
 * Automatically processes pending join requests daily
 */

import * as schedule from 'node-schedule';
import { getSocket } from '../connection';
import { processAllGroupJoinRequests, isJoinRequestProcessingEnabled } from '../joinRequestProcessor';
import { JOIN_REQUEST_PROCESS_TIME } from '../config';

let joinRequestJob: schedule.Job | null = null;

/**
 * Parse time string (HH:MM) into hour and minute
 */
function parseTime(timeStr: string): { hour: number; minute: number } {
  const [hourStr, minuteStr] = timeStr.split(':');
  return {
    hour: parseInt(hourStr, 10),
    minute: parseInt(minuteStr, 10),
  };
}

/**
 * Start the join request processor scheduler
 */
export function startJoinRequestScheduler(): void {
  const enabled = isJoinRequestProcessingEnabled();

  if (!enabled) {
    console.log('[JoinRequest] Join request auto-processing: DISABLED (AUTO_PROCESS_JOIN_REQUESTS not set to true)');
    return;
  }

  const { hour, minute } = parseTime(JOIN_REQUEST_PROCESS_TIME);

  // Schedule for Israel timezone (Asia/Jerusalem)
  const rule = new schedule.RecurrenceRule();
  rule.hour = hour;
  rule.minute = minute;
  rule.tz = 'Asia/Jerusalem';

  joinRequestJob = schedule.scheduleJob(rule, async () => {
    console.log(`[JoinRequest] Triggered at scheduled time ${hour}:${minute.toString().padStart(2, '0')} Israel time`);

    const sock = getSocket();
    if (!sock) {
      console.error('[JoinRequest] No socket connection available');
      return;
    }

    try {
      await processAllGroupJoinRequests(sock);
    } catch (error) {
      console.error('[JoinRequest] Error processing join requests:', error);
    }
  });

  console.log(`[JoinRequest] Join request auto-processing: ENABLED`);
  console.log(`[JoinRequest] Scheduled daily at ${hour}:${minute.toString().padStart(2, '0')} Israel time`);
}

/**
 * Stop the join request scheduler
 */
export function stopJoinRequestScheduler(): void {
  if (joinRequestJob) {
    joinRequestJob.cancel();
    joinRequestJob = null;
    console.log('[JoinRequest] Join request scheduler stopped');
  }
}

/**
 * Trigger join request processing manually (for testing or immediate execution)
 */
export async function triggerJoinRequestProcessing(): Promise<void> {
  const sock = getSocket();
  if (!sock) {
    throw new Error('No socket connection available');
  }

  console.log('[JoinRequest] Manually triggered join request processing');
  await processAllGroupJoinRequests(sock);
}
