/**
 * Webhook service for bot mention notifications
 */

import { getBotJid as getBotJidFromConnection, getBotLid as getBotLidFromConnection } from './connection';

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  senderName?: string;
  timestamp: number;
}

interface MentionPayload {
  groupId: string;
  groupName: string;
  senderNumber: string;
  senderName: string;
  message: string;
  messageId: string;
  timestamp: number;
  quotedMessage?: string; // The message being replied to (if reply)
  conversationHistory?: ConversationMessage[]; // Recent conversation context
}

const WEBHOOK_URL = process.env.MENTION_WEBHOOK_URL;
const API_KEY = process.env.MENTION_API_KEY;
const BOT_PHONE_NUMBER = process.env.BOT_PHONE_NUMBER;
const BOT_LID = process.env.BOT_LID; // WhatsApp internal ID (from mention logs)

/**
 * Normalize a JID by removing the device suffix (e.g., :0, :12)
 * "1602794598430:0@s.whatsapp.net" -> "1602794598430@s.whatsapp.net"
 */
function normalizeJid(jid: string): string {
  return jid.replace(/:\d+@/, '@');
}

/**
 * Extract the ID part from a JID (before the @)
 * "1602794598430@lid" -> "1602794598430"
 */
function extractId(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

/**
 * Get all bot identifiers for matching
 */
function getBotIds(): string[] {
  const botJid = getBotJidFromConnection();
  const botLid = getBotLidFromConnection();

  const botIds: string[] = [];

  // Add phone number from JID
  if (botJid) {
    botIds.push(extractId(botJid));
  }

  // Add LID if available
  if (botLid) {
    botIds.push(extractId(botLid));
  }

  // Also check env var phone number as fallback
  if (BOT_PHONE_NUMBER) {
    botIds.push(BOT_PHONE_NUMBER);
  }

  // Check BOT_LID env var (WhatsApp internal ID)
  if (BOT_LID) {
    botIds.push(BOT_LID);
  }

  return botIds;
}

/**
 * Check if the bot is mentioned in the message's mentionedJid array
 * Checks against both phone number JID and LID
 */
export function isBotMentioned(mentionedJids: string[] | null | undefined): boolean {
  if (!mentionedJids || mentionedJids.length === 0) {
    return false;
  }

  const botIds = getBotIds();

  if (botIds.length === 0) {
    console.warn('[MentionWebhook] No bot identifiers available');
    return false;
  }

  // Check if any mentioned JID matches any of the bot's identifiers
  return mentionedJids.some(jid => {
    const mentionedId = extractId(jid);
    return botIds.includes(mentionedId);
  });
}

/**
 * Check if a message is a reply to a bot message
 * @param replyToParticipant - The JID of the participant being replied to
 */
export function isReplyToBot(replyToParticipant: string | null | undefined): boolean {
  if (!replyToParticipant) {
    return false;
  }

  const botIds = getBotIds();

  if (botIds.length === 0) {
    return false;
  }

  const participantId = extractId(replyToParticipant);
  return botIds.includes(participantId);
}

/**
 * Send a webhook notification when the bot is mentioned
 */
export async function sendMentionWebhook(payload: MentionPayload): Promise<void> {
  if (!WEBHOOK_URL) {
    console.warn('[MentionWebhook] MENTION_WEBHOOK_URL not configured, skipping webhook');
    return;
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Make.com expects x-make-apikey header
    if (API_KEY) {
      headers['x-make-apikey'] = API_KEY;
    }

    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      console.log(`[${new Date().toISOString()}] Mention webhook sent successfully for message ${payload.messageId}`);
    } else {
      console.error(`[${new Date().toISOString()}] Mention webhook failed: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error sending mention webhook:`, error);
  }
}

/**
 * Log the mention webhook configuration status on startup
 */
export function logMentionWebhookConfig(): void {
  const botJid = getBotJidFromConnection();
  const botLid = getBotLidFromConnection();

  if (!WEBHOOK_URL) {
    console.log('[MentionWebhook] Bot mention detection: DISABLED (MENTION_WEBHOOK_URL not set)');
    return;
  }

  console.log(`[MentionWebhook] Bot mention detection: ENABLED`);
  console.log(`[MentionWebhook] Bot JID: ${botJid || 'waiting for connection...'}`);
  console.log(`[MentionWebhook] Bot LID (connection): ${botLid || 'not available'}`);
  console.log(`[MentionWebhook] Bot LID (env): ${BOT_LID || 'not set'}`);
  console.log(`[MentionWebhook] Bot Phone (env): ${BOT_PHONE_NUMBER || 'not set'}`);
  console.log(`[MentionWebhook] Webhook URL: ${WEBHOOK_URL.substring(0, 40)}...`);
  console.log(`[MentionWebhook] API Key: ${API_KEY ? 'configured' : 'not configured'}`);
}
