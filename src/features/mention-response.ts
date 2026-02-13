/**
 * Mention Response Feature
 * Uses Groq API to respond when the bot is mentioned in a monitored group
 */

import { getSupabaseClient, getMessagesWithLikes, savePendingResponse, getPendingResponses, deletePendingResponse, PendingResponse } from '../supabase';
import { callGroq, buildMentionPrompt } from '../services/groq';
import { isConnected, isStable, waitForStability, getSocket } from '../connection';
import { ALLOWED_GROUPS } from '../config';
import { saveMessage } from '../supabase';
import { WhatsAppMessage } from '../types';
import { formatVoiceResponse } from '../services/whisper';
import { proto } from '@whiskeysockets/baileys';
import { needsFreshData, searchTavily, formatTavilyResultsForPrompt, isAuthorizedForWebSearch, validateResponseSources, detectHallucinatedUrls, TavilySearchResult } from '../services/tavily';
import { markdownToWhatsApp } from '../utils/formatting';
import { callCopilotAgent, executeDirectCommand, isCopilotAgentEnabled, isCopilotAgentAvailable, getLandingPageTimeout, CopilotAgentOptions } from '../services/copilot-agent';
import { shouldRouteToAgent, buildVideoPrompt, extractVideoDescription, buildLandingPagePrompt, extractLandingPageDescription, isFreeChatGroup } from '../utils/agent-triggers';
import { sendVideo, sendMedia, detectMediaType } from '../utils/media-sender';
import { isCurrentlyShabbat, areGroupsAlreadyLocked } from '../shabbatLocker';

// Type alias for message key
type MessageKey = proto.IMessageKey;

// Rate limiting: track responses per user
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const MAX_RESPONSES_PER_MINUTE = 10; // Increased to allow more natural conversations
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute

// Human-like response delays (in ms) - visible typing before sending
const TYPING_DELAY_MIN = 3000;
const TYPING_DELAY_MAX = 5000;

/**
 * Get a random delay to simulate human typing
 */
function getTypingDelay(): number {
  return Math.floor(Math.random() * (TYPING_DELAY_MAX - TYPING_DELAY_MIN + 1)) + TYPING_DELAY_MIN;
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Track which messages we've already liked to avoid duplicate reactions
const likedMessagesCache = new Set<string>();

/**
 * Auto-like messages that have received likes from users
 * This makes users feel the bot appreciates their content
 */
async function autoLikePopularMessages(
  groupId: string,
  sock: any
): Promise<void> {
  // CRITICAL: No reactions during Shabbat
  if (process.env.SHABBAT_ENABLED === 'true') {
    if (isCurrentlyShabbat() || areGroupsAlreadyLocked()) {
      return;
    }
  }

  try {
    // Get messages with likes
    const likedMessages = await getMessagesWithLikes(groupId, 10);

    if (likedMessages.length === 0) {
      return;
    }

    console.log(`[MENTION] Found ${likedMessages.length} liked messages to potentially react to`);

    // Limit to max 3 reactions per batch to avoid triggering WhatsApp's bot detection
    const MAX_REACTIONS_PER_BATCH = 3;
    let reactionsThisBatch = 0;

    for (const msg of likedMessages) {
      // Stop if we've hit the batch limit
      if (reactionsThisBatch >= MAX_REACTIONS_PER_BATCH) {
        console.log(`[MENTION] Hit max reactions per batch (${MAX_REACTIONS_PER_BATCH}), stopping`);
        break;
      }

      // Only auto-like messages with MORE than 2 reactions (3+)
      if (msg.likeCount <= 2) {
        continue;
      }

      // Skip if we've already liked this message
      if (likedMessagesCache.has(msg.messageId)) {
        continue;
      }

      try {
        // Parse the message key
        const messageKey = JSON.parse(msg.messageKeyJson);

        // Choose contextual emoji based on message content
        const emoji = getContextualLikeEmoji(msg.messageBody);

        // Add a contextual reaction
        await sock.sendMessage(groupId, {
          react: { text: emoji, key: messageKey }
        });

        // Mark as liked
        likedMessagesCache.add(msg.messageId);
        reactionsThisBatch++;
        console.log(`[MENTION] Auto-reacted ${emoji} to message ${msg.messageId} (${msg.likeCount} reactions from users)`);

        // Longer delay with jitter (1.5-3 seconds) to look more human
        const jitter = Math.random() * 1500; // 0-1.5s random jitter
        await sleep(1500 + jitter);
      } catch (reactErr) {
        console.log(`[MENTION] Could not auto-like message ${msg.messageId} (non-fatal):`, reactErr);
      }
    }

    // Clean up cache if it gets too large (keep last 1000)
    if (likedMessagesCache.size > 1000) {
      const entries = Array.from(likedMessagesCache);
      entries.slice(0, 500).forEach(id => likedMessagesCache.delete(id));
    }
  } catch (err) {
    console.log('[MENTION] Error in auto-like (non-fatal):', err);
  }
}

/**
 * Typing controller - allows starting/stopping typing indicator
 */
interface TypingController {
  stop: () => void;
  promise: Promise<void>;
}

/**
 * Start continuous typing indicator that runs until stopped
 * Returns a controller to stop the typing
 */
function startTypingIndicator(sock: any, chatId: string): TypingController {
  let shouldStop = false;
  let typingStarted = false;

  const promise = (async () => {
    try {
      // Subscribe to presence (required for typing to work)
      try {
        console.log(`[TYPING] Subscribing to presence for ${chatId}...`);
        await sock.presenceSubscribe(chatId);
        console.log(`[TYPING] Presence subscribed`);
      } catch (e) {
        console.log(`[TYPING] presenceSubscribe failed (continuing anyway):`, e);
      }

      // Set available first
      try {
        await sock.sendPresenceUpdate('available', chatId);
        console.log(`[TYPING] Set presence to available`);
      } catch (e) {
        console.log(`[TYPING] sendPresenceUpdate(available) failed:`, e);
      }

      // Send first composing immediately
      try {
        await sock.sendPresenceUpdate('composing', chatId);
        typingStarted = true;
        console.log(`[TYPING] ✓ Typing indicator started in ${chatId}`);
      } catch (e) {
        console.log(`[TYPING] sendPresenceUpdate(composing) failed:`, e);
        return; // Don't continue if we can't even start typing
      }

      // Keep sending composing every 2s until stopped
      while (!shouldStop) {
        await sleep(2000);
        if (!shouldStop) {
          try {
            await sock.sendPresenceUpdate('composing', chatId);
          } catch (e) {
            console.log(`[TYPING] composing refresh failed:`, e);
          }
        }
      }

      // Stop typing
      try {
        await sock.sendPresenceUpdate('paused', chatId);
        console.log('[TYPING] ✓ Typing indicator stopped');
      } catch (e) {
        console.log(`[TYPING] sendPresenceUpdate(paused) failed:`, e);
      }
    } catch (err) {
      console.log('[TYPING] Error (non-fatal):', err);
    }
  })();

  return {
    stop: () => { shouldStop = true; },
    promise
  };
}

/**
 * React to a message with the appropriate emoji based on context
 */
async function reactToMessage(
  sock: any,
  chatId: string,
  messageKey: MessageKey,
  emoji: string = '👀'
): Promise<void> {
  try {
    console.log(`[REACTION] Sending ${emoji} reaction to message in ${chatId}...`);
    console.log(`[REACTION] Message key:`, JSON.stringify(messageKey));
    const result = await sock.sendMessage(chatId, {
      react: { text: emoji, key: messageKey }
    });
    console.log(`[REACTION] ✓ Successfully reacted with ${emoji}`, result?.key?.id ? `(msgId: ${result.key.id})` : '');
  } catch (err) {
    console.log('[REACTION] ✗ React failed:', err);
  }
}

/**
 * Get appropriate reaction emoji based on task type
 */
function getTaskEmoji(isVideo: boolean, isLandingPage: boolean, isDirectCommand: boolean): string {
  if (isVideo) return '🎬';
  if (isLandingPage) return '🌐';
  if (isDirectCommand) return '⚡';
  return '👀';
}

/**
 * Choose a contextual like emoji based on message content
 */
function getContextualLikeEmoji(messageBody: string): string {
  const lowerBody = messageBody.toLowerCase();

  // Funny/humor - use 😂
  if (lowerBody.includes('haha') || lowerBody.includes('lol') || lowerBody.includes('😂') ||
      lowerBody.includes('🤣') || lowerBody.includes('funny') || lowerBody.includes('joke') ||
      lowerBody.includes('צחוק') || lowerBody.includes('חחח') || lowerBody.includes('הההה')) {
    return '😂';
  }

  // Love/appreciation - use ❤️
  if (lowerBody.includes('love') || lowerBody.includes('❤') || lowerBody.includes('🥰') ||
      lowerBody.includes('awesome') || lowerBody.includes('amazing') || lowerBody.includes('beautiful') ||
      lowerBody.includes('אהבה') || lowerBody.includes('מדהים') || lowerBody.includes('יפה') ||
      lowerBody.includes('מושלם')) {
    return '❤️';
  }

  // Mind blown/impressive - use 🤯
  if (lowerBody.includes('wow') || lowerBody.includes('🤯') || lowerBody.includes('insane') ||
      lowerBody.includes('crazy') || lowerBody.includes('mind') || lowerBody.includes('blown') ||
      lowerBody.includes('וואו') || lowerBody.includes('מטורף')) {
    return '🤯';
  }

  // Fire/hot content - use 🔥
  if (lowerBody.includes('fire') || lowerBody.includes('🔥') || lowerBody.includes('hot') ||
      lowerBody.includes('lit') || lowerBody.includes('אש')) {
    return '🔥';
  }

  // Agreement/thumbs up - default
  return '👍';
}

// Authorized admins who can trigger Logan responses in ANY group
// Configured via MENTION_ADMIN_NUMBERS environment variable (comma-separated)
const AUTHORIZED_ADMINS = new Set(
  (process.env.MENTION_ADMIN_NUMBERS || process.env.AGENT_ADMIN_NUMBERS || '').split(',').map(n => n.trim()).filter(n => n)
);

// Groups where Logan responds to ALL users (not just admins)
// Configured via MENTION_PUBLIC_GROUPS environment variable (comma-separated)
const PUBLIC_RESPONSE_GROUPS = new Set(
  (process.env.MENTION_PUBLIC_GROUPS || process.env.AGENT_PUBLIC_GROUPS || '').split(',').map(g => g.trim()).filter(g => g)
);

/**
 * Check if a user is authorized to get Logan's response
 * Rules:
 * - DMs: respond to ALL users
 * - Public response groups: respond to ALL users
 * - Free chat groups (קבוצת הדיונים etc): respond to ALL users (text only, tools blocked)
 * - Other groups: respond ONLY to the authorized admin
 */
async function isAuthorizedForResponse(groupId: string, senderNumber: string): Promise<boolean> {
  // Normalize sender number
  const normalizedSender = senderNumber.replace(/[^0-9]/g, '');

  // Admin-only mode: only authorized admins can use Logan anywhere (groups + DMs)
  if (process.env.ADMIN_ONLY_MODE === 'true') {
    if (AUTHORIZED_ADMINS.has(normalizedSender)) {
      console.log(`[MENTION] Authorized: admin ${senderNumber} (ADMIN_ONLY_MODE)`);
      return true;
    }
    console.log(`[MENTION] Ignoring ${senderNumber} - ADMIN_ONLY_MODE is active`);
    return false;
  }

  // DMs - allow all users (when not in admin-only mode)
  if (!groupId.endsWith('@g.us')) {
    console.log(`[MENTION] Authorized: DM from ${senderNumber}`);
    return true;
  }

  // Public response groups - allow all users
  if (PUBLIC_RESPONSE_GROUPS.has(groupId)) {
    console.log(`[MENTION] Authorized: ${senderNumber} in public response group (${groupId})`);
    return true;
  }

  // Free chat groups (like קבוצת הדיונים) - allow all users for text responses (tools blocked by shouldRouteToAgent)
  if (isFreeChatGroup(groupId)) {
    console.log(`[MENTION] Authorized: ${senderNumber} in free chat group (${groupId}) - text only`);
    return true;
  }

  // Other groups - only allow the authorized admin
  if (AUTHORIZED_ADMINS.has(normalizedSender)) {
    console.log(`[MENTION] Authorized: admin ${senderNumber} in group ${groupId}`);
    return true;
  }

  console.log(`[MENTION] Ignoring - sender ${senderNumber} is not authorized in group ${groupId}`);
  return false;
}

/**
 * Check if a user is rate limited
 */
function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);

  if (!entry) {
    return false;
  }

  // Reset if window has passed
  if (now >= entry.resetAt) {
    rateLimitMap.delete(userId);
    return false;
  }

  return entry.count >= MAX_RESPONSES_PER_MINUTE;
}

/**
 * Record a response for rate limiting
 */
function recordResponse(userId: string): void {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);

  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(userId, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS
    });
  } else {
    entry.count++;
  }
}

/**
 * Get last N messages from a group
 */
async function getGroupMessages(
  groupId: string,
  limit: number = 10
): Promise<Array<{ senderName: string; body: string }>> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.error('[MENTION] Supabase not initialized');
    return [];
  }

  try {
    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('sender_name, body')
      .eq('chat_id', groupId)
      .eq('is_content', true)
      .not('body', 'is', null)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[MENTION] Error fetching group messages:', error.message);
      return [];
    }

    // Reverse to chronological order and format
    return (data || [])
      .reverse()
      .map(m => ({
        senderName: m.sender_name || 'Unknown',
        body: m.body || ''
      }));
  } catch (err) {
    console.error('[MENTION] Exception fetching group messages:', err);
    return [];
  }
}

/**
 * Get last N messages from a specific user in a group
 */
async function getUserMessages(
  groupId: string,
  senderNumber: string,
  limit: number = 3
): Promise<Array<{ body: string }>> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    console.error('[MENTION] Supabase not initialized');
    return [];
  }

  try {
    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('body')
      .eq('chat_id', groupId)
      .eq('sender_number', senderNumber)
      .eq('is_content', true)
      .not('body', 'is', null)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('[MENTION] Error fetching user messages:', error.message);
      return [];
    }

    // Reverse to chronological order
    return (data || [])
      .reverse()
      .map(m => ({ body: m.body || '' }));
  } catch (err) {
    console.error('[MENTION] Exception fetching user messages:', err);
    return [];
  }
}

/**
 * Send a response message to a group
 */
/**
 * Extract @mentions from text (e.g., "@John Doe" or "@name")
 * Returns array of mentioned names (without the @)
 */
function extractMentionsFromText(text: string): string[] {
  // Match @Name patterns - handles multi-word names like "@Amir Give'on"
  // Stops at common punctuation that would end a name
  const mentionPattern = /@([A-Za-z\u0590-\u05FF\u0400-\u04FF''\-\s]+?)(?=\s*[—\-:,.\n]|$)/g;
  const mentions: string[] = [];
  let match;
  while ((match = mentionPattern.exec(text)) !== null) {
    const name = match[1].trim();
    if (name.length > 1) { // Ignore single characters
      mentions.push(name);
    }
  }
  return mentions;
}

/**
 * Find participant JID by matching name against group members
 * Returns the JID if found, null otherwise
 */
async function findParticipantByName(
  sock: any,
  groupMetadata: any,
  targetName: string
): Promise<string | null> {
  try {
    const targetLower = targetName.toLowerCase().replace(/['']/g, "'");

    for (const participant of groupMetadata.participants) {
      // Get the participant's display name from various possible fields
      const pushName = participant.pushName || participant.notify || '';
      const pushNameLower = pushName.toLowerCase().replace(/['']/g, "'");

      // Match if target is contained in pushName or vice versa (fuzzy match)
      if (pushNameLower.includes(targetLower) || targetLower.includes(pushNameLower)) {
        // Return the @s.whatsapp.net JID (not LID)
        const jid = participant.id;
        // If it's a LID, we need the phone number version
        if (jid.endsWith('@lid')) {
          // Try to get phone number from participantPn or other field
          const pn = participant.participantPn || participant.phone;
          if (pn) {
            return pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
          }
        }
        return jid.endsWith('@s.whatsapp.net') ? jid : null;
      }
    }
    return null;
  } catch (err) {
    console.log(`[MENTION] Error finding participant by name: ${err}`);
    return null;
  }
}

async function sendResponse(
  groupId: string,
  response: string,
  mentionNumber?: string,
  messageKey?: MessageKey
): Promise<boolean> {
  // Wait for connection stability if not yet stable (handles messages during startup)
  if (!isConnected() || !isStable()) {
    console.log('[MENTION] Waiting for connection stability...');
    const stable = await waitForStability(15000);
    if (!stable) {
      console.error('[MENTION] WhatsApp not connected after waiting, cannot send response');
      return false;
    }
    console.log('[MENTION] Connection now stable, proceeding to send');
  }

  const sock = getSocket();
  if (!sock) {
    console.error('[MENTION] Socket not available');
    return false;
  }

  try {
    // Determine the correct recipient JID
    let recipientJid = groupId;

    // For DMs sent to LID format, convert to JID using the sender's phone number
    if (groupId.endsWith('@lid') && mentionNumber) {
      recipientJid = `${mentionNumber}@s.whatsapp.net`;
      console.log(`[MENTION] Converting LID to JID: ${groupId} -> ${recipientJid}`);
    }

    // For groups, refresh sender key by fetching group metadata FIRST
    // This is required before any message sending (including reactions)
    let groupMetadata: any = null;
    if (recipientJid.endsWith('@g.us')) {
      try {
        console.log('[MENTION] Refreshing group session before sending...');
        groupMetadata = await sock.groupMetadata(recipientJid);
      } catch (metaErr) {
        console.log('[MENTION] Group metadata fetch failed, continuing anyway:', metaErr);
      }
    }

    // Convert markdown formatting to WhatsApp formatting
    const formattedResponse = markdownToWhatsApp(response);
    const messageContent: { text: string; mentions?: string[] } = { text: formattedResponse };
    const mentions: string[] = [];

    // Add original sender mention if provided
    if (mentionNumber && recipientJid.endsWith('@g.us')) {
      const mentionJid = `${mentionNumber}@s.whatsapp.net`;
      mentions.push(mentionJid);
    }

    // Parse @mentions from the response text and resolve to JIDs
    if (recipientJid.endsWith('@g.us') && groupMetadata) {
      const textMentions = extractMentionsFromText(response);
      if (textMentions.length > 0) {
        console.log(`[MENTION] Found @mentions in response: ${textMentions.join(', ')}`);

        for (const name of textMentions) {
          const participantJid = await findParticipantByName(sock, groupMetadata, name);
          if (participantJid && !mentions.includes(participantJid)) {
            mentions.push(participantJid);
            console.log(`[MENTION] Resolved @${name} -> ${participantJid}`);
          } else if (!participantJid) {
            console.log(`[MENTION] Could not resolve @${name} to a participant`);
          }
        }
      }
    }

    if (mentions.length > 0) {
      messageContent.mentions = mentions;
    }

    const result = await sock.sendMessage(recipientJid, messageContent);

    // Clear typing indicator
    try {
      await sock.sendPresenceUpdate('paused', recipientJid);
    } catch (presenceErr) {
      // Non-fatal
    }

    // Change reaction from 👀 (thinking) to ✅ (done) after successful response
    if (messageKey) {
      try {
        await sock.sendMessage(groupId, {
          react: { text: '✅', key: messageKey }
        });
        console.log('[MENTION] Updated reaction to done ✅');
      } catch (reactErr) {
        console.log('[MENTION] Could not update reaction (non-fatal):', reactErr);
      }
    }

    // Log bot's outgoing message to Supabase
    const groupConfig = ALLOWED_GROUPS.find(g => g.id === groupId);
    const outgoingMessage: WhatsAppMessage = {
      id: result?.key?.id || `mention-${Date.now()}`,
      chat_id: groupId,
      chat_name: groupConfig?.name || 'Unknown Group',
      sender_name: 'Logan (Bot)',
      sender_number: process.env.BOT_PHONE_NUMBER || null,
      message_type: 'text',
      body: response,
      timestamp: Math.floor(Date.now() / 1000),
      from_me: true,
      is_group: true,
      is_content: true
    };
    await saveMessage(outgoingMessage);

    return true;
  } catch (error) {
    console.error('[MENTION] Error sending response:', error);
    return false;
  }
}

/**
 * Handle a direct shell command via Copilot Agent
 * Syntax: @Logan ! command
 */
async function handleDirectCommand(
  groupId: string,
  senderNumber: string,
  command: string,
  messageKey?: MessageKey
): Promise<boolean> {
  console.log(`[DIRECT] Executing command: "${command}"`);

  const sock = getSocket();

  // React to show we're processing
  if (sock && messageKey) {
    try {
      await sock.sendMessage(groupId, { react: { text: '⚡', key: messageKey } });
    } catch (e) {
      // Non-fatal
    }
  }

  // Check if agent is available
  const available = await isCopilotAgentAvailable();
  if (!available) {
    await sendResponse(groupId, '❌ Agent not running. Start the Copilot SDK agent first.', senderNumber, messageKey);
    return true; // Handled (with error message)
  }

  try {
    const result = await executeDirectCommand(command);

    let response: string;
    if (result.success) {
      // Format successful output
      const output = result.stdout?.trim() || '(no output)';
      response = `\`\`\`\n${output}\n\`\`\``;

      if (sock && messageKey) {
        try {
          await sock.sendMessage(groupId, { react: { text: '✅', key: messageKey } });
        } catch (e) {
          // Non-fatal
        }
      }
    } else {
      // Format error
      const error = result.stderr?.trim() || result.error || 'Unknown error';
      response = `❌ Command failed:\n\`\`\`\n${error}\n\`\`\``;

      if (sock && messageKey) {
        try {
          await sock.sendMessage(groupId, { react: { text: '❌', key: messageKey } });
        } catch (e) {
          // Non-fatal
        }
      }
    }

    await sendResponse(groupId, response, senderNumber, messageKey);
    return true;
  } catch (error) {
    console.error('[DIRECT] Error executing command:', error);
    await sendResponse(groupId, `❌ Error: ${error}`, senderNumber, messageKey);
    return true;
  }
}

/**
 * Handle a request via Copilot SDK Agent
 * Returns true if handled, false if should fallback to Groq
 */
async function handleAgentRequest(
  groupId: string,
  senderNumber: string,
  senderName: string,
  message: string,
  messageKey?: MessageKey,
  isVideoRequest: boolean = false,
  isLandingPageRequest: boolean = false,
  mediaUrl?: string,
  mediaType?: string
): Promise<boolean> {
  // Track last error for better debugging
  let lastError: string | undefined;
  const requestType = isLandingPageRequest ? 'landing page' : isVideoRequest ? 'video' : 'agent';
  console.log(`[AGENT] Processing ${requestType} request from ${senderName}: "${message.substring(0, 50)}..."`);

  // Check if agent is available
  const available = await isCopilotAgentAvailable();
  if (!available) {
    console.log('[AGENT] Copilot agent not available');

    // For landing page/video requests, show error instead of falling back to Groq
    if (isLandingPageRequest || isVideoRequest) {
      const requestType = isLandingPageRequest ? 'דף הנחיתה' : 'הוידאו';
      const errorMsg = `❌ הסוכן (Copilot Agent) לא זמין כרגע. לא ניתן ליצור ${requestType}.\n\nבדוק שהסוכן פועל ב-localhost:4001`;
      await sendResponse(groupId, errorMsg, senderNumber, messageKey);
      return true; // Return true because we handled it (with error message)
    }

    console.log('[AGENT] Will fallback to Groq');
    return false;
  }

  try {
    // Build appropriate prompt and determine timeout
    let prompt: string;
    let timeout: number | undefined;

    if (isLandingPageRequest) {
      const description = extractLandingPageDescription(message);
      prompt = buildLandingPagePrompt(description);
      timeout = getLandingPageTimeout(); // 3+ minutes for landing pages
      console.log(`[AGENT] Landing page request detected, description: "${description}", timeout: ${timeout / 1000}s`);
    } else if (isVideoRequest) {
      const description = extractVideoDescription(message);
      prompt = buildVideoPrompt(description);
      console.log(`[AGENT] Video request detected, description: "${description}"`);
    } else {
      prompt = message;
    }

    // React to show we're processing
    const sock = getSocket();
    if (sock && messageKey) {
      try {
        // Use different emoji for landing page generation (takes longer)
        const emoji = isLandingPageRequest ? '🌐' : '🤖';
        await sock.sendMessage(groupId, { react: { text: emoji, key: messageKey } });
      } catch (e) {
        // Non-fatal
      }
    }

    // Notify user that landing page generation takes time
    if (isLandingPageRequest) {
      try {
        // Determine the correct recipient JID
        let recipientJid = groupId;
        if (groupId.endsWith('@lid') && senderNumber) {
          recipientJid = `${senderNumber}@s.whatsapp.net`;
        }
        await sock?.sendMessage(recipientJid, { text: '🚀 יוצר את דף הנחיתה שלך... זה ייקח כ-8-12 דקות (כולל וידאו, קוד Opus 4.5, ודפלוי).' });
      } catch (e) {
        console.log('[AGENT] Could not send waiting message (non-fatal)');
      }
    }

    // Call the Copilot agent with appropriate timeout and optional media
    console.log(`[AGENT] Calling Copilot SDK agent...${timeout ? ` (timeout: ${timeout / 1000}s)` : ''}${mediaUrl ? ` (with image: ${mediaType || 'unknown'})` : ''}`);
    const agentOptions: CopilotAgentOptions = { timeout };
    if (mediaUrl) {
      agentOptions.mediaUrl = mediaUrl;
    }
    if (mediaType) {
      agentOptions.mediaType = mediaType;
    }
    const agentResponse = await callCopilotAgent(prompt, agentOptions);

    if (!agentResponse.success) {
      lastError = agentResponse.error || 'Unknown agent error';
      console.error(`[AGENT] Agent call failed: ${lastError}`);

      // Update reaction to show failure
      if (sock && messageKey) {
        try {
          await sock.sendMessage(groupId, { react: { text: '❌', key: messageKey } });
        } catch (e) {
          // Non-fatal
        }
      }

      // For landing page/video requests that failed, send error message directly here
      // (since these requests showed "wait X minutes" message, we need to close the loop)
      if (isLandingPageRequest || isVideoRequest) {
        const requestType = isLandingPageRequest ? 'דף הנחיתה' : 'הוידאו';
        const errorMsg = `❌ אירעה שגיאה ביצירת ${requestType}.\n\nפרטי השגיאה: ${lastError}\n\nנסה שוב מאוחר יותר או בדוק שהסוכן פועל.`;
        await sendResponse(groupId, errorMsg, senderNumber, messageKey);
        return true; // Return true because we handled it (with error message)
      }

      return false;
    }

    // Check if we got a media file (video/image)
    if (agentResponse.mediaPath) {
      console.log(`[AGENT] Media file generated: ${agentResponse.mediaPath}`);

      const mediaType = detectMediaType(agentResponse.mediaPath);
      const caption = agentResponse.response || `Generated ${mediaType} for ${senderName}`;

      if (mediaType === 'video') {
        // Retry logic for video sending (connection may have dropped during generation)
        const maxRetries = 5;
        const retryDelayMs = 20000; // 20 seconds between retries (total ~100s max wait)

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          console.log(`[AGENT] Video send attempt ${attempt}/${maxRetries}`);

          // Wait for connection to stabilize (longer wait for retries)
          const waitTime = attempt === 1 ? 15000 : 30000;
          if (!isConnected() || !isStable()) {
            console.log(`[AGENT] Waiting ${waitTime / 1000}s for connection stability...`);
            const stable = await waitForStability(waitTime);
            if (!stable && attempt < maxRetries) {
              console.log(`[AGENT] Connection not stable, will retry in ${retryDelayMs / 1000}s...`);
              await sleep(retryDelayMs);
              continue;
            }
          }

          const result = await sendVideo(groupId, agentResponse.mediaPath, caption, senderNumber);
          if (result.success) {
            console.log(`[AGENT] Video sent successfully to ${groupId} (attempt ${attempt})`);
            // Update reaction to success
            if (sock && messageKey) {
              try {
                await sock.sendMessage(groupId, { react: { text: '🎬', key: messageKey } });
              } catch (e) {
                // Non-fatal
              }
            }
            return true;
          } else {
            console.error(`[AGENT] Video send attempt ${attempt} failed: ${result.error}`);
            if (attempt < maxRetries) {
              console.log(`[AGENT] Retrying in ${retryDelayMs / 1000}s...`);
              await sleep(retryDelayMs);
            }
          }
        }

        // All retries failed - persist to Supabase for later delivery
        console.error(`[AGENT] Failed to send video after ${maxRetries} attempts`);

        // Save pending video response to Supabase
        const videoResponse = `🎬 Video: ${agentResponse.mediaPath}`;
        const saved = await savePendingResponse({
          group_id: groupId,
          sender_number: senderNumber,
          sender_name: senderName,
          response: videoResponse,
          response_type: 'video',
          retry_count: maxRetries
        });

        if (saved) {
          console.log(`[AGENT] Pending video response saved to Supabase - will be delivered when connection is restored`);
        } else {
          console.error(`[AGENT] CRITICAL: Could not save pending video response! Path may be lost: ${agentResponse.mediaPath}`);
        }

        // Try to send text response if connection is available
        if (isConnected() && isStable()) {
          await sendResponse(groupId, `🎬 Video generated but delivery failed. File saved at: ${agentResponse.mediaPath}`, senderNumber, messageKey);
        }
        return true;
      } else {
        // Send other media types
        const result = await sendMedia(groupId, agentResponse.mediaPath, caption, senderNumber);
        if (result.success) {
          if (sock && messageKey) {
            try {
              await sock.sendMessage(groupId, { react: { text: '✅', key: messageKey } });
            } catch (e) {
              // Non-fatal
            }
          }
          return true;
        }
      }
    }

    // Send text response
    if (agentResponse.response) {
      // For landing page requests, use retry logic since connection may have dropped during long generation
      if (isLandingPageRequest) {
        const maxRetries = 5;
        const retryDelayMs = 20000; // 20 seconds between retries

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          console.log(`[AGENT] Landing page response send attempt ${attempt}/${maxRetries}`);

          // Wait for connection to stabilize (longer wait for retries)
          const waitTime = attempt === 1 ? 15000 : 30000;
          if (!isConnected() || !isStable()) {
            console.log(`[AGENT] Waiting ${waitTime / 1000}s for connection stability...`);
            const stable = await waitForStability(waitTime);
            if (!stable && attempt < maxRetries) {
              console.log(`[AGENT] Connection not stable, will retry in ${retryDelayMs / 1000}s...`);
              await sleep(retryDelayMs);
              continue;
            }
          }

          const sent = await sendResponse(groupId, agentResponse.response, senderNumber, messageKey);
          if (sent) {
            console.log(`[AGENT] Landing page response sent to ${senderName} (attempt ${attempt})`);
            // Update reaction to success
            if (sock && messageKey) {
              try {
                await sock.sendMessage(groupId, { react: { text: '✅', key: messageKey } });
              } catch (e) {
                // Non-fatal
              }
            }
            return true;
          } else {
            console.error(`[AGENT] Send attempt ${attempt} failed`);
            if (attempt < maxRetries) {
              console.log(`[AGENT] Retrying in ${retryDelayMs / 1000}s...`);
              await sleep(retryDelayMs);
            }
          }
        }

        // All retries failed - persist to Supabase for later delivery
        console.error(`[AGENT] Failed to send landing page response after ${maxRetries} attempts`);
        console.log(`[AGENT] Landing page URL that couldn't be delivered: ${agentResponse.response}`);

        // Save to Supabase for delivery when connection is restored
        const saved = await savePendingResponse({
          group_id: groupId,
          sender_number: senderNumber,
          sender_name: senderName,
          response: agentResponse.response,
          response_type: 'landing_page',
          retry_count: maxRetries
        });

        if (saved) {
          console.log(`[AGENT] Pending response saved to Supabase - will be delivered when connection is restored`);
        } else {
          console.error(`[AGENT] CRITICAL: Could not save pending response to Supabase! URL may be lost: ${agentResponse.response}`);
        }

        return true; // Still return true since the landing page was created
      }

      // Regular text response (non-landing page)
      const sent = await sendResponse(groupId, agentResponse.response, senderNumber, messageKey);
      if (sent) {
        console.log(`[AGENT] Response sent to ${senderName}`);
        return true;
      }
    }

    console.log('[AGENT] No response or media from agent');

    // For landing page/video requests, send error instead of silently failing
    if (isLandingPageRequest || isVideoRequest) {
      const requestType = isLandingPageRequest ? 'דף הנחיתה' : 'הוידאו';
      const errorMsg = `❌ הסוכן לא החזיר תוצאה ליצירת ${requestType}. נסה שוב מאוחר יותר.`;
      await sendResponse(groupId, errorMsg, senderNumber, messageKey);
      return true; // Return true because we handled it (with error message)
    }

    return false;
  } catch (error) {
    console.error('[AGENT] Error in agent request:', error);

    // For landing page/video requests, send error message
    if (isLandingPageRequest || isVideoRequest) {
      const requestType = isLandingPageRequest ? 'דף הנחיתה' : 'הוידאו';
      const errorMsg = `❌ אירעה שגיאה ביצירת ${requestType}: ${error instanceof Error ? error.message : 'Unknown error'}`;
      try {
        await sendResponse(groupId, errorMsg, senderNumber, messageKey);
        return true; // Return true because we handled it (with error message)
      } catch {
        // If we can't even send the error, fall through
      }
    }

    return false;
  }
}

/**
 * Handle a mention of the bot
 */
export async function handleMention(
  groupId: string,
  groupName: string,
  senderNumber: string,
  senderName: string,
  message: string,
  messageKey?: MessageKey,
  mediaUrl?: string,
  mediaType?: string
): Promise<void> {
  console.log(`[MENTION] ${senderName} tagged Logan in ${groupName}`);

  // For groups, only respond to authorized admin in allowed group
  if (groupId.endsWith('@g.us')) {
    const isAuthorized = await isAuthorizedForResponse(groupId, senderNumber);
    if (!isAuthorized) {
      console.log(`[MENTION] Ignoring ${senderName} - not authorized in group ${groupName}`);
      return;
    }
  }

  // Check rate limiting
  if (isRateLimited(senderNumber)) {
    console.log(`[MENTION] Rate limited: ${senderNumber} has exceeded ${MAX_RESPONSES_PER_MINUTE} requests per minute`);
    return;
  }

  // CRITICAL: Don't respond during Shabbat (even if groups are somehow open)
  if (process.env.SHABBAT_ENABLED === 'true') {
    if (isCurrentlyShabbat() || areGroupsAlreadyLocked()) {
      console.log(`[MENTION] 🕯️ SHABBAT MODE - Not responding to ${senderName} (groups should be locked)`);
      return;
    }
  }

  // Check if Groq API is configured (we need this for fallback at minimum)
  if (!process.env.GROQ_API_KEY) {
    console.warn('[MENTION] GROQ_API_KEY not configured, skipping AI response');
    return;
  }

  try {
    // Check if this should be routed to Copilot Agent
    if (isCopilotAgentEnabled()) {
      console.log(`[MENTION] DEBUG: Checking trigger for message: "${message.substring(0, 80)}..."`);
      const triggerResult = shouldRouteToAgent(message, senderNumber, groupId);
      console.log(`[MENTION] DEBUG: Trigger result:`, JSON.stringify(triggerResult));

      if (triggerResult.shouldUseAgent) {
        console.log(`[MENTION] Routing to Copilot Agent (trigger: ${triggerResult.triggerType})`);

        let handled = false;

        // Handle direct shell commands separately (! prefix)
        if (triggerResult.isDirectCommand && triggerResult.extractedCommand) {
          handled = await handleDirectCommand(
            groupId,
            senderNumber,
            triggerResult.extractedCommand,
            messageKey
          );
        } else {
          // Handle agent requests (>> prefix, video, or landing page)
          handled = await handleAgentRequest(
            groupId,
            senderNumber,
            senderName,
            triggerResult.extractedCommand || message,
            messageKey,
            triggerResult.isVideoRequest,
            triggerResult.isLandingPageRequest,
            mediaUrl,
            mediaType
          );
        }

        if (handled) {
          recordResponse(senderNumber);
          return;
        }

        // Agent failed - handle based on request type
        if (triggerResult.isDirectCommand) {
          return; // Don't fallback for direct commands
        }

        // For landing page requests, show error instead of falling back to Groq
        // (user already saw "8-12 minutes" message, so Groq fallback would be confusing)
        if (triggerResult.isLandingPageRequest) {
          console.log('[MENTION] Landing page agent failed, showing error (not falling back to Groq)');
          await sendResponse(
            groupId,
            '❌ אירעה שגיאה ביצירת דף הנחיתה. נסה שוב מאוחר יותר או בדוק שהסוכן פועל.',
            senderNumber,
            messageKey
          );
          return;
        }

        // For video requests, also show error instead of falling back
        if (triggerResult.isVideoRequest) {
          console.log('[MENTION] Video agent failed, showing error (not falling back to Groq)');
          await sendResponse(
            groupId,
            '❌ אירעה שגיאה ביצירת הוידאו. נסה שוב מאוחר יותר או בדוק שהסוכן פועל.',
            senderNumber,
            messageKey
          );
          return;
        }

        // For generic >> agent requests, fall through to Groq
        console.log('[MENTION] Agent failed, falling back to Groq');
      }
    }

    // Standard Groq flow
    const sock = getSocket();

    // STEP 0: Refresh group session FIRST (required for reactions and typing to work)
    if (sock && groupId.endsWith('@g.us')) {
      try {
        console.log('[MENTION] DEBUG: Refreshing group session...');
        await sock.groupMetadata(groupId);
        console.log('[MENTION] DEBUG: Group session refreshed');
      } catch (metaErr) {
        console.log('[MENTION] DEBUG: Group metadata fetch failed (continuing anyway):', metaErr);
      }
    }

    // STEP 1: React with emoji FIRST to acknowledge the message
    console.log('[MENTION] DEBUG: STEP 1 - Reacting with 👀 emoji...');
    if (sock && messageKey) {
      await reactToMessage(sock, groupId, messageKey, '👀');
      console.log('[MENTION] DEBUG: Reaction sent');
      // Small delay to ensure reaction is visible before typing starts
      await sleep(300);
    } else {
      console.log('[MENTION] DEBUG: No socket or messageKey, skipping reaction');
    }

    // STEP 2: Start typing indicator BEFORE calling the LLM
    console.log('[MENTION] DEBUG: STEP 2 - Starting typing indicator...');
    let typingController: TypingController | null = null;
    if (sock) {
      typingController = startTypingIndicator(sock, groupId);
      // Give typing indicator time to start
      await sleep(500);
      console.log('[MENTION] DEBUG: Typing indicator started');
    }

    try {
      console.log('[MENTION] DEBUG: STEP 3 - Calling LLM...');
      // Get context - keep it small to reduce token usage and avoid rate limits
      const [groupMessages, userMessages] = await Promise.all([
        getGroupMessages(groupId, 15),
        getUserMessages(groupId, senderNumber, 5)
      ]);

      // Check if this query needs real-time web search (restricted to admin and brain emoji group)
      let webSearchContext = '';
      let searchResults: TavilySearchResult[] = [];
      let usedWebSearch = false;
      if (needsFreshData(message)) {
        if (isAuthorizedForWebSearch(groupId, senderNumber)) {
          console.log(`[MENTION] Query needs fresh data, searching Tavily: "${message}"`);
          const { answer, results, error } = await searchTavily(message, groupId, senderNumber, senderName);
          if (!error && (answer || results.length > 0)) {
            webSearchContext = formatTavilyResultsForPrompt(results, answer);
            searchResults = results;
            usedWebSearch = true;
            console.log(`[MENTION] Got ${results.length} web search results, adding to context`);
          } else {
            console.log(`[MENTION] Web search returned no results or error: ${error || 'empty'}`);
          }
        } else {
          console.log(`[MENTION] Web search not authorized for ${senderNumber} in ${groupId}`);
        }
      }

      // Build prompt with optional web search context
      const prompt = buildMentionPrompt(groupMessages, userMessages, senderName, message, webSearchContext);

      // Call Groq API - use free chat prompt for free chat groups
      const useFreeChatPrompt = isFreeChatGroup(groupId);
      let response = await callGroq(prompt, useFreeChatPrompt);

      console.log('[MENTION] DEBUG: LLM responded');

      // STEP 4: Stop typing indicator after LLM responds
      console.log('[MENTION] DEBUG: STEP 4 - Stopping typing indicator...');
      if (typingController) {
        typingController.stop();
        console.log('[MENTION] DEBUG: Typing stopped');
      }

      if (!response) {
        console.error('[MENTION] Failed to get response from Groq API');
        return;
      }

      // STEP 4.5: Validate web search response sources (if web search was used)
      // Helper to check if response says "didn't find info"
      const responseIndicatesNoInfo = (text: string): boolean => {
        const noInfoPatterns = [
          /לא מצאתי מידע/i,
          /לא מצאתי תוצאות/i,
          /לא נמצא מידע/i,
          /אין לי מידע/i,
          /לא יודע/i,
          /לא הצלחתי למצוא/i,
          /didn't find/i,
          /could not find/i,
          /no information/i,
          /no relevant/i,
        ];
        return noInfoPatterns.some(pattern => pattern.test(text));
      };

      if (usedWebSearch && searchResults.length > 0) {
        console.log('[MENTION] DEBUG: Validating web search sources...');

        // Check for hallucinated URLs
        const suspiciousUrls = detectHallucinatedUrls(response);
        if (suspiciousUrls.length > 0) {
          console.log(`[MENTION] WARNING: Detected ${suspiciousUrls.length} suspicious/hallucinated URL(s): ${suspiciousUrls.join(', ')}`);
        }

        // CRITICAL: If response says "didn't find info", strip any URLs - they're irrelevant!
        if (responseIndicatesNoInfo(response)) {
          console.log(`[MENTION] Response says "no info found" - stripping any URLs to prevent irrelevant links`);
          const sourcePattern = /\n?🔗\s*מקור:?\s*https?:\/\/[^\s\n]+/gi;
          const urlOnlyPattern = /\n?https?:\/\/[^\s\n]+$/gi;
          response = response.replace(sourcePattern, '').replace(urlOnlyPattern, '').trim();
        } else {
          // Validate that response uses actual search results
          const validation = validateResponseSources(response, searchResults);

          if (!validation.isValid) {
            console.log(`[MENTION] WARNING: Response does not contain valid source from search results!`);
            console.log(`[MENTION] Expected domains: ${validation.expectedDomains.join(', ')}`);
            console.log(`[MENTION] Found URLs: ${validation.foundUrls.join(', ') || 'none'}`);

            // Append the best source from search results (only if we have actual content)
            if (validation.suggestion) {
              response += validation.suggestion;
              console.log(`[MENTION] Added source from search results: ${searchResults[0].url}`);
            }
          } else {
            console.log(`[MENTION] Response validated - contains source from search results`);
          }
        }
      } else {
        // IMPORTANT: If no web search was used, strip any hallucinated URLs/sources
        // The model sometimes hallucinates "🔗 מקור:" even without search results
        const sourcePattern = /\n?🔗\s*מקור:?\s*https?:\/\/[^\s\n]+/gi;
        const urlOnlyPattern = /\n?https?:\/\/[^\s\n]+$/gi;
        if (sourcePattern.test(response) || urlOnlyPattern.test(response)) {
          console.log(`[MENTION] WARNING: Stripping hallucinated URL from response (no web search was used)`);
          response = response.replace(sourcePattern, '').replace(urlOnlyPattern, '').trim();
        }
      }

      // STEP 5: Send response
      console.log('[MENTION] DEBUG: STEP 5 - Sending response...');
      const sent = await sendResponse(groupId, response, senderNumber, messageKey);

      if (sent) {
        console.log(`[MENTION] Responded to ${senderName}`);
        recordResponse(senderNumber);

        // Auto-like popular messages (runs asynchronously, non-blocking)
        if (sock && groupId.endsWith('@g.us')) {
          autoLikePopularMessages(groupId, sock).catch(err => {
            console.log('[MENTION] Auto-like error (non-fatal):', err);
          });
        }
      } else {
        console.error('[MENTION] Failed to send response');
      }
    } finally {
      // Ensure typing is stopped even if an error occurs
      if (typingController) {
        typingController.stop();
      }
    }
  } catch (error) {
    console.error('[MENTION] Error handling mention:', error);
  }
}

/**
 * Handle a voice message mention (transcribed audio)
 */
export async function handleVoiceMention(
  groupId: string,
  groupName: string,
  senderNumber: string,
  senderName: string,
  transcription: string,
  isError: boolean = false,
  messageKey?: MessageKey,
  mediaUrl?: string,
  mediaType?: string
): Promise<void> {
  console.log(`[VOICE] Processing voice from ${senderName} in ${groupName}`);

  // For groups, only respond to authorized admin in allowed group
  if (groupId.endsWith('@g.us')) {
    const isAuthorized = await isAuthorizedForResponse(groupId, senderNumber);
    if (!isAuthorized) {
      console.log(`[VOICE] Ignoring ${senderName} - not authorized in group ${groupName}`);
      return;
    }
  }

  // If it's an error message, just send it directly
  if (isError) {
    const errorMessage = transcription.replace('[ERROR] ', '');
    const sent = await sendResponse(groupId, errorMessage, senderNumber);
    if (sent) {
      console.log(`[VOICE] Sent error response to ${senderName}`);
    }
    return;
  }

  // Check rate limiting
  if (isRateLimited(senderNumber)) {
    console.log(`[VOICE] Rate limited: ${senderNumber} has exceeded ${MAX_RESPONSES_PER_MINUTE} requests per minute`);
    return;
  }

  // CRITICAL: Don't respond during Shabbat (even if groups are somehow open)
  if (process.env.SHABBAT_ENABLED === 'true') {
    if (isCurrentlyShabbat() || areGroupsAlreadyLocked()) {
      console.log(`[VOICE] 🕯️ SHABBAT MODE - Not responding to ${senderName} (groups should be locked)`);
      return;
    }
  }

  // Check if Groq API is configured (needed for fallback at minimum)
  if (!process.env.GROQ_API_KEY) {
    console.warn('[VOICE] GROQ_API_KEY not configured, skipping AI response');
    return;
  }

  try {
    // Check if this should be routed to Copilot Agent (video, direct commands, etc.)
    if (isCopilotAgentEnabled()) {
      const triggerResult = shouldRouteToAgent(transcription, senderNumber, groupId);

      if (triggerResult.shouldUseAgent) {
        console.log(`[VOICE] Routing to Copilot Agent (trigger: ${triggerResult.triggerType})`);

        let handled = false;

        // Handle direct shell commands (! prefix in voice transcription)
        if (triggerResult.isDirectCommand && triggerResult.extractedCommand) {
          handled = await handleDirectCommand(
            groupId,
            senderNumber,
            triggerResult.extractedCommand,
            messageKey
          );
        } else {
          // Handle agent requests (video generation, landing page, >> prefix, etc.)
          handled = await handleAgentRequest(
            groupId,
            senderNumber,
            senderName,
            triggerResult.extractedCommand || transcription,
            messageKey,
            triggerResult.isVideoRequest,
            triggerResult.isLandingPageRequest,
            mediaUrl,
            mediaType
          );
        }

        if (handled) {
          recordResponse(senderNumber);
          return;
        }

        // Agent failed - handle based on request type
        if (triggerResult.isDirectCommand) {
          return; // Don't fallback for direct commands
        }

        // For landing page requests, show error instead of falling back to Groq
        if (triggerResult.isLandingPageRequest) {
          console.log('[VOICE] Landing page agent failed, showing error (not falling back to Groq)');
          await sendResponse(
            groupId,
            '❌ אירעה שגיאה ביצירת דף הנחיתה. נסה שוב מאוחר יותר או בדוק שהסוכן פועל.',
            senderNumber,
            messageKey
          );
          return;
        }

        // For video requests, also show error instead of falling back
        if (triggerResult.isVideoRequest) {
          console.log('[VOICE] Video agent failed, showing error (not falling back to Groq)');
          await sendResponse(
            groupId,
            '❌ אירעה שגיאה ביצירת הוידאו. נסה שוב מאוחר יותר או בדוק שהסוכן פועל.',
            senderNumber,
            messageKey
          );
          return;
        }

        // For generic >> agent requests, fall through to Groq
        console.log('[VOICE] Agent failed, falling back to Groq');
      }
    }

    // Standard Groq flow
    const sock = getSocket();

    // STEP 0: Refresh group session FIRST (required for reactions and typing to work)
    if (sock && groupId.endsWith('@g.us')) {
      try {
        console.log('[VOICE] DEBUG: Refreshing group session...');
        await sock.groupMetadata(groupId);
        console.log('[VOICE] DEBUG: Group session refreshed');
      } catch (metaErr) {
        console.log('[VOICE] DEBUG: Group metadata fetch failed (continuing anyway):', metaErr);
      }
    }

    // STEP 1: React with emoji FIRST to acknowledge the voice message
    console.log('[VOICE] DEBUG: STEP 1 - Reacting with 🎤 emoji...');
    if (sock && messageKey) {
      await reactToMessage(sock, groupId, messageKey, '🎤');
      console.log('[VOICE] DEBUG: Reaction sent');
      // Small delay to ensure reaction is visible before typing starts
      await sleep(300);
    } else {
      console.log('[VOICE] DEBUG: No socket or messageKey, skipping reaction');
    }

    // STEP 2: Start typing indicator BEFORE calling the LLM
    console.log('[VOICE] DEBUG: STEP 2 - Starting typing indicator...');
    let typingController: TypingController | null = null;
    if (sock) {
      typingController = startTypingIndicator(sock, groupId);
      // Give typing indicator time to start
      await sleep(500);
      console.log('[VOICE] DEBUG: Typing indicator started');
    }

    try {
      console.log('[VOICE] DEBUG: STEP 3 - Calling LLM...');
      // Get context - keep it small to reduce token usage and avoid rate limits
      const [groupMessages, userMessages] = await Promise.all([
        getGroupMessages(groupId, 15),
        getUserMessages(groupId, senderNumber, 5)
      ]);

      // Check if this query needs real-time web search (restricted to admin and brain emoji group)
      let webSearchContext = '';
      let searchResults: TavilySearchResult[] = [];
      let usedWebSearch = false;
      if (needsFreshData(transcription)) {
        if (isAuthorizedForWebSearch(groupId, senderNumber)) {
          console.log(`[VOICE] Query needs fresh data, searching Tavily: "${transcription}"`);
          const { answer, results, error } = await searchTavily(transcription, groupId, senderNumber, senderName);
          if (!error && (answer || results.length > 0)) {
            webSearchContext = formatTavilyResultsForPrompt(results, answer);
            searchResults = results;
            usedWebSearch = true;
            console.log(`[VOICE] Got ${results.length} web search results, adding to context`);
          } else {
            console.log(`[VOICE] Web search returned no results or error: ${error || 'empty'}`);
          }
        } else {
          console.log(`[VOICE] Web search not authorized for ${senderNumber} in ${groupId}`);
        }
      }

      // Build prompt (use transcription as the message)
      const prompt = buildMentionPrompt(groupMessages, userMessages, senderName, transcription, webSearchContext);

      // Call Groq API - use free chat prompt for free chat groups
      const useFreeChatPrompt = isFreeChatGroup(groupId);
      let response = await callGroq(prompt, useFreeChatPrompt);

      console.log('[VOICE] DEBUG: LLM responded');

      // STEP 4: Stop typing indicator after LLM responds
      console.log('[VOICE] DEBUG: STEP 4 - Stopping typing indicator...');
      if (typingController) {
        typingController.stop();
        console.log('[VOICE] DEBUG: Typing stopped');
      }

      if (!response) {
        console.error('[VOICE] Failed to get response from Groq API');
        return;
      }

      // STEP 4.5: Validate web search response sources (if web search was used)
      // Helper to check if response says "didn't find info"
      const voiceResponseIndicatesNoInfo = (text: string): boolean => {
        const noInfoPatterns = [
          /לא מצאתי מידע/i,
          /לא מצאתי תוצאות/i,
          /לא נמצא מידע/i,
          /אין לי מידע/i,
          /לא יודע/i,
          /לא הצלחתי למצוא/i,
          /didn't find/i,
          /could not find/i,
          /no information/i,
          /no relevant/i,
        ];
        return noInfoPatterns.some(pattern => pattern.test(text));
      };

      if (usedWebSearch && searchResults.length > 0) {
        console.log('[VOICE] DEBUG: Validating web search sources...');

        // Check for hallucinated URLs
        const suspiciousUrls = detectHallucinatedUrls(response);
        if (suspiciousUrls.length > 0) {
          console.log(`[VOICE] WARNING: Detected ${suspiciousUrls.length} suspicious/hallucinated URL(s): ${suspiciousUrls.join(', ')}`);
        }

        // CRITICAL: If response says "didn't find info", strip any URLs - they're irrelevant!
        if (voiceResponseIndicatesNoInfo(response)) {
          console.log(`[VOICE] Response says "no info found" - stripping any URLs to prevent irrelevant links`);
          const sourcePattern = /\n?🔗\s*מקור:?\s*https?:\/\/[^\s\n]+/gi;
          const urlOnlyPattern = /\n?https?:\/\/[^\s\n]+$/gi;
          response = response.replace(sourcePattern, '').replace(urlOnlyPattern, '').trim();
        } else {
          // Validate that response uses actual search results
          const validation = validateResponseSources(response, searchResults);

          if (!validation.isValid) {
            console.log(`[VOICE] WARNING: Response does not contain valid source from search results!`);
            console.log(`[VOICE] Expected domains: ${validation.expectedDomains.join(', ')}`);
            console.log(`[VOICE] Found URLs: ${validation.foundUrls.join(', ') || 'none'}`);

            // Append the best source from search results (only if we have actual content)
            if (validation.suggestion) {
              response += validation.suggestion;
              console.log(`[VOICE] Added source from search results: ${searchResults[0].url}`);
            }
          } else {
            console.log(`[VOICE] Response validated - contains source from search results`);
          }
        }
      } else {
        // IMPORTANT: If no web search was used, strip any hallucinated URLs/sources
        const sourcePattern = /\n?🔗\s*מקור:?\s*https?:\/\/[^\s\n]+/gi;
        const urlOnlyPattern = /\n?https?:\/\/[^\s\n]+$/gi;
        if (sourcePattern.test(response) || urlOnlyPattern.test(response)) {
          console.log(`[VOICE] WARNING: Stripping hallucinated URL from response (no web search was used)`);
          response = response.replace(sourcePattern, '').replace(urlOnlyPattern, '').trim();
        }
      }

      // Format response with transcription reference
      const formattedResponse = formatVoiceResponse(response, transcription);

      // STEP 5: Send response
      console.log('[VOICE] DEBUG: STEP 5 - Sending response...');
      const sent = await sendResponse(groupId, formattedResponse, senderNumber, messageKey);

      if (sent) {
        console.log(`[VOICE] Responded to ${senderName}`);
        recordResponse(senderNumber);
      } else {
        console.error('[VOICE] Failed to send response');
      }
    } finally {
      // Ensure typing is stopped even if an error occurs
      if (typingController) {
        typingController.stop();
      }
    }
  } catch (error) {
    console.error('[VOICE] Error handling voice mention:', error);
  }
}

/**
 * Check if the mention response feature is enabled
 */
export function isMentionResponseEnabled(): boolean {
  return !!process.env.GROQ_API_KEY;
}

/**
 * Log mention response configuration on startup
 */
export function logMentionResponseConfig(): void {
  if (isMentionResponseEnabled()) {
    console.log(`[MENTION] AI mention response: ENABLED (using Groq API)`);
    console.log(`[MENTION] Rate limit: ${MAX_RESPONSES_PER_MINUTE} responses per user per minute`);
    console.log(`[MENTION] Tavily web search: ENABLED (for fresh data queries)`);

    // Log global free chat mode with exact env value
    const envValue = (process.env.LOGAN_FREE_CHAT_MODE || '').trim().toLowerCase();
    const globalFreeChatMode = envValue === 'true';
    console.log(`[MENTION] ========================================`);
    console.log(`[MENTION] LOGAN_FREE_CHAT_MODE raw value: "${process.env.LOGAN_FREE_CHAT_MODE}"`);
    console.log(`[MENTION] LOGAN_FREE_CHAT_MODE parsed: "${envValue}" → ${globalFreeChatMode}`);
    if (globalFreeChatMode) {
      console.log(`[MENTION] ✓✓✓ FREE CHAT MODE ACTIVE - Unrestricted prompt EVERYWHERE`);
    } else {
      console.log(`[MENTION] ✗✗✗ FREE CHAT MODE DISABLED - Using restricted prompt`);
    }
    console.log(`[MENTION] ========================================`);

    // Log Copilot Agent status
    if (isCopilotAgentEnabled()) {
      console.log(`[MENTION] Copilot SDK Agent: ENABLED`);
      console.log(`[MENTION]   URL: ${process.env.COPILOT_AGENT_URL || 'http://localhost:4001'}`);
      console.log(`[MENTION]   Commands:`);
      console.log(`[MENTION]     (default)       → Groq (fast chat)`);
      console.log(`[MENTION]     צור וידאו...    → Agent (video)`);
      console.log(`[MENTION]     דף נחיתה ל...   → Agent (landing page, ~3min)`);
      console.log(`[MENTION]     >> prompt       → Agent (tools)`);
      console.log(`[MENTION]     ! command       → Shell (no AI)`);

      // Check availability asynchronously
      isCopilotAgentAvailable().then(available => {
        console.log(`[MENTION]   Status: ${available ? '✓ Agent online' : '✗ Agent offline'}`);
      });
    } else {
      console.log(`[MENTION] Copilot SDK Agent: DISABLED (set COPILOT_AGENT_ENABLED=true)`);
    }
  } else {
    console.log(`[MENTION] AI mention response: DISABLED (GROQ_API_KEY not set)`);
  }
}

/**
 * Process pending responses that couldn't be delivered due to connection issues
 * Should be called when connection becomes stable (e.g., on reconnect)
 */
export async function processPendingResponses(): Promise<void> {
  console.log('[PENDING] Checking for pending responses...');

  // CRITICAL: Don't deliver pending responses during Shabbat
  if (process.env.SHABBAT_ENABLED === 'true') {
    if (isCurrentlyShabbat() || areGroupsAlreadyLocked()) {
      console.log('[PENDING] 🕯️ SHABBAT MODE - Skipping pending responses delivery');
      return;
    }
  }

  // Wait for connection to be stable
  if (!isConnected() || !isStable()) {
    const stable = await waitForStability(10000);
    if (!stable) {
      console.log('[PENDING] Connection not stable, will retry later');
      return;
    }
  }

  try {
    const pendingResponses = await getPendingResponses();

    if (pendingResponses.length === 0) {
      console.log('[PENDING] No pending responses to process');
      return;
    }

    console.log(`[PENDING] Found ${pendingResponses.length} pending response(s) to deliver`);

    for (const pending of pendingResponses) {
      // Check connection before each attempt
      if (!isConnected() || !isStable()) {
        console.log('[PENDING] Connection lost during pending response processing, stopping');
        break;
      }

      console.log(`[PENDING] Delivering ${pending.response_type} response to ${pending.sender_name} (${pending.group_id})`);

      try {
        // Get the socket
        const sock = getSocket();
        if (!sock) {
          console.error('[PENDING] Socket not available');
          break;
        }

        // Determine recipient JID
        let recipientJid = pending.group_id;
        if (pending.group_id.endsWith('@lid') && pending.sender_number) {
          recipientJid = `${pending.sender_number}@s.whatsapp.net`;
        }

        // For groups, refresh session first
        if (recipientJid.endsWith('@g.us')) {
          try {
            await sock.groupMetadata(recipientJid);
          } catch (e) {
            // Continue anyway
          }
        }

        // Format the delayed delivery message
        const delayedPrefix = '📬 *תגובה מושהית* (היה בעיית חיבור):\n\n';
        const messageText = delayedPrefix + pending.response;

        // Send the message
        await sock.sendMessage(recipientJid, { text: messageText });

        console.log(`[PENDING] Successfully delivered ${pending.response_type} response to ${pending.sender_name}`);

        // Delete from pending queue
        if (pending.id) {
          await deletePendingResponse(pending.id);
        }

        // Small delay between messages
        await sleep(1000);
      } catch (err) {
        console.error(`[PENDING] Failed to deliver pending response to ${pending.sender_name}:`, err);
        // Continue with next pending response
      }
    }

    console.log('[PENDING] Finished processing pending responses');
  } catch (err) {
    console.error('[PENDING] Error processing pending responses:', err);
  }
}
