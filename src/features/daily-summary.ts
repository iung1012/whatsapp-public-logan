/**
 * Daily Summary Feature
 * Uses Claude API to generate daily summaries of group conversations
 */

import * as schedule from 'node-schedule';
import * as fs from 'fs';
import * as path from 'path';
import { getSupabaseClient } from '../supabase';
import { callClaude, callClaudeForVoice, buildDailySummaryPrompt, callClaudeForMasterSummary, callClaudeForMasterVoice, buildMasterSummaryPrompt } from '../services/claude';
import { textToSpeech, isElevenLabsEnabled } from '../services/elevenlabs';
import { isConnected, isStable, getSocket } from '../connection';
import { ALLOWED_GROUPS } from '../config';
import { saveMessage } from '../supabase';
import { WhatsAppMessage } from '../types';
import { checkShabbatTimes } from '../shabbatLocker';
import { markdownToWhatsApp } from '../utils/formatting';
import {
  canBroadcast,
  markBroadcastStarted,
  markBroadcastCompleted,
  markBroadcastFailed,
  recordGroupSent,
  hasGroupReceived,
  getOperationKey
} from '../broadcastGuard';

let dailySummaryJob: schedule.Job | null = null;
let erevShabbatSummaryTimer: NodeJS.Timeout | null = null;
let shabbatCheckTimer: NodeJS.Timeout | null = null;

// Lock to prevent multiple summaries for the same group running simultaneously (in-memory)
const summaryInProgress = new Set<string>();

// Persistent cooldown state - survives restarts/crashes
const SUMMARY_COOLDOWN_FILE = path.join(process.cwd(), 'summary-cooldown.json');
const SUMMARY_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes cooldown between summaries for same group
const SUMMARY_STALE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes - if "running" for longer, consider it stale/crashed

interface SummaryCooldownEntry {
  lastSentAt: number;  // Unix timestamp when summary was completed
  lastSentType: 'text' | 'voice' | 'both';
  status: 'completed' | 'running' | 'failed';
  startedAt?: number;  // Unix timestamp when summary started
  runId?: string;      // Unique ID for the current run
}

interface SummaryCooldownState {
  [groupId: string]: SummaryCooldownEntry;
}

// Generate unique run ID
function generateRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Current run ID (set when summary starts)
let currentRunId: string | null = null;

/**
 * Load cooldown state from file
 */
function loadCooldownState(): SummaryCooldownState {
  try {
    if (fs.existsSync(SUMMARY_COOLDOWN_FILE)) {
      const data = fs.readFileSync(SUMMARY_COOLDOWN_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('[DAILY] Error loading cooldown state:', error);
  }
  return {};
}

/**
 * Save cooldown state to file
 */
function saveCooldownState(state: SummaryCooldownState): void {
  try {
    fs.writeFileSync(SUMMARY_COOLDOWN_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('[DAILY] Error saving cooldown state:', error);
  }
}

/**
 * Check if a summary run is stale (started but never completed, and too old)
 */
function isRunStale(entry: SummaryCooldownEntry): boolean {
  if (entry.status !== 'running') return false;
  if (!entry.startedAt) return true; // No start time = definitely stale

  const elapsed = Date.now() - entry.startedAt;
  return elapsed > SUMMARY_STALE_TIMEOUT_MS;
}

/**
 * Check if a group is in cooldown period or has a running summary
 */
export function isGroupInCooldown(groupId: string): { inCooldown: boolean; remainingMs: number; lastSentAt: Date | null; isRunning: boolean } {
  const state = loadCooldownState();
  const groupState = state[groupId];

  if (!groupState) {
    return { inCooldown: false, remainingMs: 0, lastSentAt: null, isRunning: false };
  }

  // Check if there's a running summary that's NOT stale
  if (groupState.status === 'running' && !isRunStale(groupState)) {
    console.log(`[DAILY] Group ${groupId} has active running summary (started ${Math.round((Date.now() - (groupState.startedAt || 0)) / 1000)}s ago)`);
    return {
      inCooldown: true,
      remainingMs: SUMMARY_STALE_TIMEOUT_MS - (Date.now() - (groupState.startedAt || 0)),
      lastSentAt: groupState.startedAt ? new Date(groupState.startedAt) : null,
      isRunning: true
    };
  }

  // Check completed cooldown
  if (groupState.status === 'completed') {
    const now = Date.now();
    const elapsed = now - groupState.lastSentAt;
    const remaining = SUMMARY_COOLDOWN_MS - elapsed;

    return {
      inCooldown: remaining > 0,
      remainingMs: Math.max(0, remaining),
      lastSentAt: new Date(groupState.lastSentAt),
      isRunning: false
    };
  }

  // Stale or failed - allow retry
  return { inCooldown: false, remainingMs: 0, lastSentAt: null, isRunning: false };
}

/**
 * Mark a summary as STARTED (running)
 */
function markSummaryStarted(groupId: string, runId: string): void {
  const state = loadCooldownState();
  state[groupId] = {
    lastSentAt: state[groupId]?.lastSentAt || 0,
    lastSentType: state[groupId]?.lastSentType || 'text',
    status: 'running',
    startedAt: Date.now(),
    runId: runId
  };
  saveCooldownState(state);
  console.log(`[DAILY] Summary STARTED for ${groupId} (runId: ${runId})`);
}

/**
 * Mark a summary as COMPLETED
 */
function markSummaryCompleted(groupId: string, type: 'text' | 'voice' | 'both', runId: string): void {
  const state = loadCooldownState();

  // Only update if this is the current run (prevent stale updates)
  if (state[groupId]?.runId && state[groupId].runId !== runId) {
    console.log(`[DAILY] Ignoring completion for stale runId ${runId} (current: ${state[groupId].runId})`);
    return;
  }

  state[groupId] = {
    lastSentAt: Date.now(),
    lastSentType: type,
    status: 'completed',
    startedAt: state[groupId]?.startedAt,
    runId: runId
  };
  saveCooldownState(state);
  console.log(`[DAILY] Summary COMPLETED for ${groupId} - cooldown ${SUMMARY_COOLDOWN_MS / 60000} minutes`);
}

/**
 * Mark a summary as FAILED
 */
function markSummaryFailed(groupId: string, runId: string): void {
  const state = loadCooldownState();

  // Only update if this is the current run
  if (state[groupId]?.runId && state[groupId].runId !== runId) {
    console.log(`[DAILY] Ignoring failure for stale runId ${runId}`);
    return;
  }

  state[groupId] = {
    ...state[groupId],
    status: 'failed',
    runId: runId
  };
  saveCooldownState(state);
  console.log(`[DAILY] Summary FAILED for ${groupId}`);
}

// Legacy function for backward compatibility
function markSummarySent(groupId: string, type: 'text' | 'voice' | 'both'): void {
  markSummaryCompleted(groupId, type, currentRunId || generateRunId());
}

const MAX_WAIT_FOR_CONNECTION_MS = 90000; // Wait up to 90 seconds for reconnection

/**
 * Wait for WhatsApp connection to be stable with timeout
 */
async function waitForConnection(maxWaitMs: number = MAX_WAIT_FOR_CONNECTION_MS): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    if (isConnected() && isStable() && getSocket()) {
      return true;
    }
    // Check every 2 seconds
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log(`[DAILY] Waiting for connection... (${Math.round((Date.now() - startTime) / 1000)}s)`);
  }

  return isConnected() && getSocket() !== null;
}

/**
 * Generate TTS audio with presence keepalive to prevent connection drops.
 * ElevenLabs TTS can take ~30 seconds, during which WhatsApp may drop the connection (status 440).
 * Sending 'recording' presence updates keeps the connection alive.
 */
async function generateTTSWithKeepalive(
  voiceSummary: string,
  targetId: string
): Promise<Buffer | null> {
  const sock = getSocket();
  if (!sock) {
    console.error('[DAILY] Socket not available for TTS keepalive');
    return await textToSpeech(voiceSummary);
  }

  // Start presence keepalive - shows "recording audio..." which is appropriate
  let keepAliveInterval: NodeJS.Timeout | null = null;

  try {
    // Send initial presence update
    await sock.sendPresenceUpdate('recording', targetId);
    console.log(`[DAILY] Started presence keepalive for TTS generation`);

    // Keep sending presence updates every 10 seconds during TTS generation
    keepAliveInterval = setInterval(async () => {
      try {
        await sock.sendPresenceUpdate('recording', targetId);
      } catch (err) {
        console.warn('[DAILY] Presence keepalive ping failed:', err);
      }
    }, 10000);

    // Generate TTS (this can take ~30 seconds)
    const audioBuffer = await textToSpeech(voiceSummary);

    return audioBuffer;
  } finally {
    // Clean up keepalive interval
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
    }

    // Clear presence
    try {
      await sock.sendPresenceUpdate('paused', targetId);
      console.log(`[DAILY] Cleared presence after TTS generation`);
    } catch (err) {
      console.warn('[DAILY] Failed to clear presence:', err);
    }
  }
}

/**
 * Get the configured summary time (default 22:00 Israel time)
 */
function getSummaryTime(): { hour: number; minute: number } {
  const timeStr = process.env.DAILY_SUMMARY_TIME || '22:00';
  const [hour, minute] = timeStr.split(':').map(Number);
  return { hour: hour || 22, minute: minute || 0 };
}

/**
 * Get messages from the last 24 hours for a group
 */
async function getGroupMessagesLast24Hours(
  groupId: string
): Promise<Array<{ senderName: string | null; senderNumber: string | null; body: string | null }>> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.error('[DAILY] Supabase not initialized');
    return [];
  }

  const twentyFourHoursAgo = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);

  try {
    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('sender_name, sender_number, body')
      .eq('chat_id', groupId)
      .eq('is_content', true)
      .gte('timestamp', twentyFourHoursAgo)
      .order('timestamp', { ascending: true })
      .limit(770);

    if (error) {
      console.error('[DAILY] Error fetching group messages:', error.message);
      return [];
    }

    // Map snake_case fields from Supabase to camelCase
    return (data || []).map(m => ({
      senderName: m.sender_name,
      senderNumber: m.sender_number,
      body: m.body
    }));
  } catch (err) {
    console.error('[DAILY] Exception fetching group messages:', err);
    return [];
  }
}

/**
 * Get messages from all monitored groups (excluding channels) for master summary
 */
async function getAllGroupsMessagesLast24Hours(
  groupIds: string[]
): Promise<{ messagesByGroup: Map<string, Array<{ senderName: string | null; body: string | null }>>; totalCount: number }> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.error('[DAILY] Supabase not initialized');
    return { messagesByGroup: new Map(), totalCount: 0 };
  }

  const twentyFourHoursAgo = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  const messagesByGroup = new Map<string, Array<{ senderName: string | null; body: string | null }>>();
  let totalCount = 0;

  try {
    for (const groupId of groupIds) {
      const { data, error } = await supabase
        .from('whatsapp_messages')
        .select('sender_name, body, chat_name')
        .eq('chat_id', groupId)
        .eq('is_content', true)
        .gte('timestamp', twentyFourHoursAgo)
        .order('timestamp', { ascending: true })
        .limit(200); // Limit per group for master summary

      if (error) {
        console.error(`[DAILY] Error fetching messages for ${groupId}:`, error.message);
        continue;
      }

      if (data && data.length > 0) {
        const groupName = data[0].chat_name || groupId;
        const messages = data.map(m => ({
          senderName: m.sender_name,
          body: m.body
        }));
        messagesByGroup.set(groupName, messages);
        totalCount += data.length;
      }
    }

    return { messagesByGroup, totalCount };
  } catch (err) {
    console.error('[DAILY] Exception fetching all groups messages:', err);
    return { messagesByGroup: new Map(), totalCount: 0 };
  }
}

/**
 * Process and send master channel summary (combined from all groups)
 */
async function processMasterChannelSummary(masterChannelId: string, groupIds: string[]): Promise<boolean> {
  const channelConfig = ALLOWED_GROUPS.find(g => g.id === masterChannelId);
  const channelName = channelConfig?.name || 'Master Channel';

  console.log(`[DAILY] Generating master summary for channel from ${groupIds.length} groups`);

  try {
    // Get messages from all groups
    const { messagesByGroup, totalCount } = await getAllGroupsMessagesLast24Hours(groupIds);

    if (totalCount === 0) {
      console.log('[DAILY] No messages found across all groups, skipping master summary');
      return true;
    }

    console.log(`[DAILY] Found ${totalCount} total messages from ${messagesByGroup.size} groups`);

    // Build prompt for master summary
    const prompt = buildMasterSummaryPrompt(messagesByGroup, totalCount);

    // Generate text summary
    const textSummary = await callClaudeForMasterSummary(prompt);

    if (!textSummary) {
      console.error('[DAILY] Failed to generate master text summary');
      return false;
    }

    console.log(`[DAILY] Generated master text summary: ${textSummary.length} chars`);

    // Send text summary to channel
    const textSent = await sendMessage(masterChannelId, textSummary);

    if (textSent) {
      console.log(`[DAILY] Master summary text sent to ${channelName}`);
    } else {
      console.error(`[DAILY] Failed to send master summary to ${channelName}`);
      return false;
    }

    // Generate and send voice summary if ElevenLabs is enabled
    if (isElevenLabsEnabled()) {
      console.log('[DAILY] Generating master voice summary');

      const voiceSummary = await callClaudeForMasterVoice(prompt);

      if (!voiceSummary) {
        console.error('[DAILY] Failed to generate master voice summary');
      } else {
        console.log(`[DAILY] Generated master voice summary: ${voiceSummary.length} chars`);

        // Convert to speech with presence keepalive to prevent connection drops
        const audioBuffer = await generateTTSWithKeepalive(voiceSummary, masterChannelId);

        if (!audioBuffer) {
          console.error('[DAILY] Failed to convert master voice summary to speech');
        } else {
          console.log(`[DAILY] Master TTS audio generated: ${audioBuffer.length} bytes`);

          await new Promise(resolve => setTimeout(resolve, 2000));

          const voiceSent = await sendVoiceMessage(masterChannelId, audioBuffer);

          if (voiceSent) {
            console.log(`[DAILY] Master voice sent to ${channelName}`);
          } else {
            console.error(`[DAILY] Failed to send master voice to ${channelName}`);
          }
        }
      }
    }

    console.log('[DAILY] Master summary sent to channel');
    return true;
  } catch (error) {
    console.error('[DAILY] Error processing master channel summary:', error);
    return false;
  }
}

/**
 * Send a message to a group
 */
async function sendMessage(groupId: string, message: string): Promise<boolean> {
  // Wait for connection if not connected (handle frequent 440 disconnects)
  if (!isConnected() || !isStable()) {
    console.log('[DAILY] WhatsApp not connected, waiting for reconnection...');
    const connected = await waitForConnection();
    if (!connected) {
      console.error('[DAILY] WhatsApp not connected after waiting, cannot send message');
      return false;
    }
    console.log('[DAILY] Connection restored, proceeding with send');
  }

  const sock = getSocket();
  if (!sock) {
    console.error('[DAILY] Socket not available');
    return false;
  }

  try {
    // Convert markdown formatting to WhatsApp formatting (** → *, etc.)
    const formattedMessage = markdownToWhatsApp(message);
    const result = await sock.sendMessage(groupId, { text: formattedMessage });

    // Log bot's outgoing message to Supabase
    const groupConfig = ALLOWED_GROUPS.find(g => g.id === groupId);
    const outgoingMessage: WhatsAppMessage = {
      id: result?.key?.id || `daily-${Date.now()}`,
      chat_id: groupId,
      chat_name: groupConfig?.name || 'Unknown Group',
      sender_name: 'Logan (Bot)',
      sender_number: process.env.BOT_PHONE_NUMBER || null,
      message_type: 'text',
      body: message,
      timestamp: Math.floor(Date.now() / 1000),
      from_me: true,
      is_group: true,
      is_content: true
    };
    await saveMessage(outgoingMessage);

    return true;
  } catch (error) {
    console.error('[DAILY] Error sending message:', error);
    return false;
  }
}

/**
 * Send a voice message to a group
 */
async function sendVoiceMessage(groupId: string, audioBuffer: Buffer): Promise<boolean> {
  // Wait for connection if not connected (handle frequent 440 disconnects)
  if (!isConnected() || !isStable()) {
    console.log('[DAILY] WhatsApp not connected, waiting for reconnection...');
    const connected = await waitForConnection();
    if (!connected) {
      console.error('[DAILY] WhatsApp not connected after waiting, cannot send voice message');
      return false;
    }
    console.log('[DAILY] Connection restored, proceeding with voice send');
  }

  const sock = getSocket();
  if (!sock) {
    console.error('[DAILY] Socket not available');
    return false;
  }

  try {
    const result = await sock.sendMessage(groupId, {
      audio: audioBuffer,
      mimetype: 'audio/mpeg',
      ptt: true // Push-to-talk (voice note)
    });

    // Log bot's outgoing voice message to Supabase
    const groupConfig = ALLOWED_GROUPS.find(g => g.id === groupId);
    const outgoingMessage: WhatsAppMessage = {
      id: result?.key?.id || `daily-voice-${Date.now()}`,
      chat_id: groupId,
      chat_name: groupConfig?.name || 'Unknown Group',
      sender_name: 'Logan (Bot)',
      sender_number: process.env.BOT_PHONE_NUMBER || null,
      message_type: 'audio',
      body: '[Voice Summary]',
      timestamp: Math.floor(Date.now() / 1000),
      from_me: true,
      is_group: true,
      is_content: true
    };
    await saveMessage(outgoingMessage);

    return true;
  } catch (error) {
    console.error('[DAILY] Error sending voice message:', error);
    return false;
  }
}

/**
 * Check if a summary is already in progress for a group
 */
export function isSummaryInProgress(groupId: string): boolean {
  return summaryInProgress.has(groupId);
}

/**
 * Generate and send daily summary for a single group
 * @param groupId - The WhatsApp group ID
 * @param groupName - Display name of the group
 * @param bypassCooldown - If true, skip cooldown check (use for scheduled summaries)
 */
export async function processGroupSummary(groupId: string, groupName: string, bypassCooldown: boolean = false): Promise<boolean> {
  // Check cooldown FIRST (persistent, survives restarts)
  if (!bypassCooldown) {
    const cooldown = isGroupInCooldown(groupId);
    if (cooldown.inCooldown) {
      const remainingMinutes = Math.ceil(cooldown.remainingMs / 60000);
      console.log(`[DAILY] Group ${groupName} is in cooldown. Last summary: ${cooldown.lastSentAt?.toISOString()}. Remaining: ${remainingMinutes} minutes. BLOCKING.`);
      return false;
    }
  }

  // Check if summary is already in progress for this group (in-memory lock)
  if (summaryInProgress.has(groupId)) {
    console.log(`[DAILY] Summary already in progress for ${groupName}, skipping duplicate request`);
    return false;
  }

  // Acquire in-memory lock
  summaryInProgress.add(groupId);
  console.log(`[DAILY] Starting daily summary for ${groupName}`);

  try {
    // Get messages from last 24 hours
    const messages = await getGroupMessagesLast24Hours(groupId);

    if (messages.length === 0) {
      console.log(`[DAILY] No messages found for ${groupName}, skipping`);
      return true; // Not an error, just nothing to summarize
    }

    console.log(`[DAILY] Found ${messages.length} messages for ${groupName}`);

    // Build prompt for Claude
    const prompt = buildDailySummaryPrompt(messages);

    // Generate text summary (with mentions)
    const textSummary = await callClaude(prompt);

    if (!textSummary) {
      console.error(`[DAILY] Failed to generate text summary for ${groupName}`);
      return false;
    }

    console.log(`[DAILY] Generated text summary: ${textSummary.length} chars`);

    // Send text summary to group
    const textSent = await sendMessage(groupId, textSummary);

    if (textSent) {
      console.log(`[DAILY] Text sent to ${groupName}`);
      // CRITICAL: Mark cooldown immediately after text is sent
      // This prevents duplicate sends even if connection drops during voice processing
      markSummarySent(groupId, 'text');
    } else {
      console.error(`[DAILY] Failed to send text summary to ${groupName}`);
      return false;
    }

    // Generate and send voice summary if ElevenLabs is enabled
    if (isElevenLabsEnabled()) {
      console.log(`[DAILY] Generating voice summary for ${groupName}`);

      // Generate voice-friendly summary (no mentions, emojis, special chars)
      const voiceSummary = await callClaudeForVoice(prompt);

      if (!voiceSummary) {
        console.error(`[DAILY] Failed to generate voice summary for ${groupName}`);
        // Continue - text summary was already sent
      } else {
        console.log(`[DAILY] Generated voice summary: ${voiceSummary.length} chars`);

        // Convert to speech with presence keepalive to prevent connection drops
        const audioBuffer = await generateTTSWithKeepalive(voiceSummary, groupId);

        if (!audioBuffer) {
          console.error(`[DAILY] Failed to convert voice summary to speech for ${groupName}`);
        } else {
          console.log(`[DAILY] TTS audio generated: ${audioBuffer.length} bytes`);

          // Wait 2 seconds before sending voice message
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Send voice message
          const voiceSent = await sendVoiceMessage(groupId, audioBuffer);

          if (voiceSent) {
            console.log(`[DAILY] Voice sent to ${groupName}`);
          } else {
            console.error(`[DAILY] Failed to send voice summary to ${groupName}`);
          }
        }
      }
    } else {
      console.log(`[DAILY] Voice summary skipped - ElevenLabs not configured`);
    }

    return true;
  } catch (error) {
    console.error(`[DAILY] Error processing summary for ${groupName}:`, error);
    return false;
  } finally {
    // Always release the lock
    summaryInProgress.delete(groupId);
    console.log(`[DAILY] Summary lock released for ${groupName}`);
  }
}

// Special key for all-groups cooldown
const ALL_GROUPS_COOLDOWN_KEY = 'ALL_GROUPS_SUMMARY';

/**
 * Check if the all-groups summary is in cooldown
 */
export function isAllGroupsSummaryInCooldown(): { inCooldown: boolean; remainingMs: number; lastSentAt: Date | null; isRunning: boolean } {
  return isGroupInCooldown(ALL_GROUPS_COOLDOWN_KEY);
}

// In-memory lock to prevent concurrent summary runs (atomic check)
let summaryRunInProgress = false;

/**
 * Run daily summary for all monitored groups
 * @param isErevShabbatSummary - If true, this is the early Erev Shabbat summary
 * @param forceRun - If true, bypass Shabbat check (for testing)
 */
export async function runDailySummary(isErevShabbatSummary: boolean = false, forceRun: boolean = false): Promise<void> {
  const summaryType = isErevShabbatSummary ? 'Erev Shabbat' : 'regular';
  const broadcastType = isErevShabbatSummary ? 'erev-shabbat-summary' : 'daily-summary';

  // ATOMIC CHECK 1: In-memory lock (prevents concurrent runs in same process)
  if (summaryRunInProgress) {
    console.error(`[DAILY] Summary already running in-memory - BLOCKING duplicate trigger`);
    return;
  }

  // ATOMIC CHECK 2: Supabase broadcast guard (survives restarts, truly atomic)
  const canProceed = await canBroadcast(broadcastType as any);
  if (!canProceed.canProceed) {
    console.error(`[DAILY] Supabase broadcast guard BLOCKED: ${canProceed.reason}`);
    return;
  }

  // ATOMIC CHECK 3: File-based lock as fallback (survives restarts if Supabase unavailable)
  const globalCooldown = isGroupInCooldown(ALL_GROUPS_COOLDOWN_KEY);
  if (globalCooldown.isRunning) {
    console.error(`[DAILY] Summary already running (file lock) - BLOCKING duplicate trigger`);
    return;
  }
  if (globalCooldown.inCooldown && !globalCooldown.isRunning) {
    const remainingMinutes = Math.ceil(globalCooldown.remainingMs / 60000);
    console.error(`[DAILY] All-groups summary is in cooldown. Last run: ${globalCooldown.lastSentAt?.toISOString()}. Remaining: ${remainingMinutes} minutes. BLOCKING.`);
    return;
  }

  // Acquire in-memory lock
  summaryRunInProgress = true;

  // Mark as STARTED in Supabase (atomic, survives any number of restarts)
  const supabaseRunId = await markBroadcastStarted(broadcastType as any);
  if (!supabaseRunId) {
    console.error(`[DAILY] Failed to mark broadcast started in Supabase - continuing anyway`);
  }

  // Also mark in file as fallback
  const runId = supabaseRunId || generateRunId();
  currentRunId = runId;
  markSummaryStarted(ALL_GROUPS_COOLDOWN_KEY, runId);

  const operationKey = getOperationKey(broadcastType as any);

  let success = false;

  try {
    // Get groups (not channels) for individual summaries
    const groups = ALLOWED_GROUPS.filter(g => g.id.endsWith('@g.us'));
    const masterChannel = process.env.SUMMARY_MASTER_CHANNEL;

    console.log(`[DAILY] Starting ${summaryType} daily summary (runId: ${runId}) for ${groups.length} groups`);

    // Check if Claude API is configured
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn('[DAILY] ANTHROPIC_API_KEY not configured, skipping daily summary');
      return;
    }

    // Check WhatsApp connection
    if (!isConnected() || !isStable()) {
      console.error('[DAILY] WhatsApp not connected, skipping daily summary');
      return;
    }

    // Check Shabbat status for regular summaries (not Erev Shabbat ones)
    // Skip this check if forceRun is true (for testing)
    if (!isErevShabbatSummary && !forceRun) {
      try {
        const shabbatStatus = await checkShabbatTimes();

        // Skip if it's currently Shabbat (Motzei Shabbat - groups are locked)
        if (shabbatStatus.isCurrentlyShabbat) {
          console.log('[DAILY] Currently Shabbat/Holiday - skipping regular summary');
          return;
        }

        // Skip if Erev Shabbat - summary was already sent earlier
        if (shabbatStatus.isErevShabbat) {
          console.log('[DAILY] Erev Shabbat - summary was sent earlier, skipping regular time');
          return;
        }
      } catch (error) {
        console.error('[DAILY] Error checking Shabbat status:', error);
        // Continue with summary if we can't check Shabbat status
      }
    } else if (forceRun) {
      console.log('[DAILY] Force run enabled - bypassing Shabbat check');
    }

    // Step 1: Send individual summaries to each group
    // Scheduled runs bypass cooldown since they are the intended daily summary
    for (const group of groups) {
      // Check if connection dropped mid-run
      if (!isConnected()) {
        console.error(`[DAILY] Connection lost during summary run - aborting`);
        return;
      }

      // Check if this group already received the broadcast (handles partial failures)
      const alreadyReceived = await hasGroupReceived(broadcastType as any, group.id);
      if (alreadyReceived) {
        console.log(`[DAILY] Group ${group.name} already received ${broadcastType}, skipping`);
        continue;
      }

      const groupSuccess = await processGroupSummary(group.id, group.name, true); // bypassCooldown=true for scheduled runs

      // Record that this group received the message (survives restarts)
      if (groupSuccess && supabaseRunId) {
        await recordGroupSent(operationKey, supabaseRunId, group.id);
        console.log(`[DAILY] Recorded group ${group.name} as sent in Supabase`);
      }

      // Wait 10 seconds between groups to avoid rate limiting
      if (groups.indexOf(group) < groups.length - 1) {
        console.log('[DAILY] Waiting 10 seconds before next group...');
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }

    // Step 2: Send combined summary to master channel
    if (masterChannel) {
      // Check connection again before master channel
      if (!isConnected()) {
        console.error(`[DAILY] Connection lost before master channel - aborting`);
        return;
      }

      console.log('[DAILY] Waiting 10 seconds before master channel summary...');
      await new Promise(resolve => setTimeout(resolve, 10000));

      const groupIds = groups.map(g => g.id);
      await processMasterChannelSummary(masterChannel, groupIds);
    }

    success = true;
    console.log(`[DAILY] ${summaryType} daily summary process completed (runId: ${runId})`);
  } finally {
    // Release in-memory lock
    summaryRunInProgress = false;
    currentRunId = null;

    // Update Supabase broadcast guard
    if (supabaseRunId) {
      if (success) {
        await markBroadcastCompleted(operationKey, supabaseRunId);
        console.log(`[DAILY] Marked broadcast COMPLETED in Supabase`);
      } else {
        await markBroadcastFailed(operationKey, supabaseRunId, 'Summary run did not complete successfully');
        console.log(`[DAILY] Marked broadcast FAILED in Supabase`);
      }
    }

    // Update file-based state as fallback
    if (success) {
      markSummaryCompleted(ALL_GROUPS_COOLDOWN_KEY, 'both', runId);
    } else {
      markSummaryFailed(ALL_GROUPS_COOLDOWN_KEY, runId);
    }

    console.log(`[DAILY] Summary run lock released (runId: ${runId}, success: ${success})`);
  }
}

/**
 * Schedule Erev Shabbat summary if applicable
 */
async function scheduleErevShabbatSummary(): Promise<void> {
  // Clear any existing Erev Shabbat timer
  if (erevShabbatSummaryTimer) {
    clearTimeout(erevShabbatSummaryTimer);
    erevShabbatSummaryTimer = null;
  }

  try {
    const shabbatStatus = await checkShabbatTimes();

    if (shabbatStatus.isErevShabbat && shabbatStatus.summaryTime) {
      const now = new Date();
      const summaryTime = shabbatStatus.summaryTime;

      if (summaryTime > now) {
        const msUntilSummary = summaryTime.getTime() - now.getTime();

        console.log(`[DAILY] Erev Shabbat detected - scheduling early summary for ${summaryTime.toLocaleString('he-IL')}`);

        erevShabbatSummaryTimer = setTimeout(async () => {
          console.log('[DAILY] Running Erev Shabbat summary (30 min before candle lighting)');
          await runDailySummary(true);
        }, msUntilSummary);
      } else {
        console.log(`[DAILY] Erev Shabbat summary time already passed: ${summaryTime.toLocaleString('he-IL')}`);
      }
    }
  } catch (error) {
    console.error('[DAILY] Error scheduling Erev Shabbat summary:', error);
  }
}

/**
 * Start the daily summary scheduler
 */
export function startDailySummary(): void {
  const enabled = process.env.DAILY_SUMMARY_ENABLED === 'true';

  if (!enabled) {
    console.log('[DAILY] Daily summary: DISABLED (DAILY_SUMMARY_ENABLED not set to true)');
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[DAILY] Daily summary: DISABLED (ANTHROPIC_API_KEY not set)');
    return;
  }

  const { hour, minute } = getSummaryTime();

  // Schedule for Israel timezone (Asia/Jerusalem)
  // node-schedule uses local time by default, but we want Israel time
  const rule = new schedule.RecurrenceRule();
  rule.hour = hour;
  rule.minute = minute;
  rule.tz = 'Asia/Jerusalem';

  dailySummaryJob = schedule.scheduleJob(rule, async () => {
    console.log(`[DAILY] Triggered at scheduled time ${hour}:${minute.toString().padStart(2, '0')} Israel time`);
    await runDailySummary();
  });

  const groups = ALLOWED_GROUPS.filter(g => g.id.endsWith('@g.us'));
  const masterChannel = process.env.SUMMARY_MASTER_CHANNEL;

  console.log(`[DAILY] Daily summary: ENABLED`);
  console.log(`[DAILY] Scheduled for ${hour}:${minute.toString().padStart(2, '0')} Israel time (Asia/Jerusalem)`);
  console.log(`[DAILY] Groups to summarize: ${groups.length}`);

  if (masterChannel) {
    const channelConfig = ALLOWED_GROUPS.find(g => g.id === masterChannel);
    console.log(`[DAILY] Master channel: ${channelConfig?.name || masterChannel}`);
  } else {
    console.log(`[DAILY] Master channel: DISABLED (SUMMARY_MASTER_CHANNEL not set)`);
  }

  // Schedule Erev Shabbat summary check
  scheduleErevShabbatSummary();

  // Re-check for Erev Shabbat daily at 06:00 Israel time
  const shabbatCheckRule = new schedule.RecurrenceRule();
  shabbatCheckRule.hour = 6;
  shabbatCheckRule.minute = 0;
  shabbatCheckRule.tz = 'Asia/Jerusalem';

  schedule.scheduleJob(shabbatCheckRule, () => {
    console.log('[DAILY] Running daily Shabbat schedule check');
    scheduleErevShabbatSummary();
  });

  if (isElevenLabsEnabled()) {
    console.log(`[DAILY] Voice summaries: ENABLED (ElevenLabs configured)`);
  } else {
    console.log(`[DAILY] Voice summaries: DISABLED (ELEVENLABS_API_KEY not set)`);
  }
}

/**
 * Stop the daily summary scheduler
 */
export function stopDailySummary(): void {
  if (dailySummaryJob) {
    dailySummaryJob.cancel();
    dailySummaryJob = null;
  }
  if (erevShabbatSummaryTimer) {
    clearTimeout(erevShabbatSummaryTimer);
    erevShabbatSummaryTimer = null;
  }
  if (shabbatCheckTimer) {
    clearTimeout(shabbatCheckTimer);
    shabbatCheckTimer = null;
  }
  console.log('[DAILY] Daily summary scheduler stopped');
}

/**
 * Check if daily summary is enabled
 */
export function isDailySummaryEnabled(): boolean {
  return process.env.DAILY_SUMMARY_ENABLED === 'true' && !!process.env.ANTHROPIC_API_KEY;
}
