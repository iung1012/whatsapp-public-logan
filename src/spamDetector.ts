import { WASocket, proto, GroupMetadata } from '@whiskeysockets/baileys';
import { ALLOWED_GROUPS } from './config';
import { isCurrentlyShabbat, areGroupsAlreadyLocked } from './shabbatLocker';

// Configuration
const SPAM_DETECTION_ENABLED = process.env.SPAM_DETECTION_ENABLED === 'true';
const SPAM_WHITELIST = (process.env.SPAM_WHITELIST || '').split(',').filter(Boolean);
const SPAM_ADMIN_NOTIFY = (process.env.SPAM_ADMIN_NOTIFY || process.env.SPAM_WHITELIST || '').split(',').filter(Boolean);
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_SPAM_MODEL = 'openai/gpt-oss-20b'; // Small/fast model to conserve tokens

// Warning tracking: user -> { count, lastWarningTime }
const warningTracker = new Map<string, { count: number; lastWarningTime: number }>();
const WARNING_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// WhatsApp group link pattern
const WHATSAPP_GROUP_LINK_REGEX = /chat\.whatsapp\.com\/([A-Za-z0-9]{20,})/gi;

// High-confidence spam signals (used as pre-filter before LLM)
const PROMO_SIGNALS = [
  'הצטרפו לקבוצה', 'בואו לקבוצה', 'הצטרפו עכשיו', 'הרשמו עכשיו',
  'רווח מובטח', 'הכנסה פסיבית', 'השקעה בטוחה', 'מבצע מטורף',
  'join our group', 'join now', 'free money', 'guaranteed profit',
  'passive income', 'limited time offer', 'act now',
];

function hasGroupLink(text: string): boolean {
  return WHATSAPP_GROUP_LINK_REGEX.test(text);
}

function countPromoSignals(text: string): number {
  const lower = text.toLowerCase();
  return PROMO_SIGNALS.filter(s => lower.includes(s.toLowerCase())).length;
}

/**
 * Pre-filter: decide if this message needs LLM analysis at all.
 * Most messages will be skipped here - saving tokens.
 */
function needsLlmCheck(text: string): { needs: boolean; reason: string } {
  // Reset regex lastIndex since it's global
  WHATSAPP_GROUP_LINK_REGEX.lastIndex = 0;
  const hasLink = hasGroupLink(text);
  WHATSAPP_GROUP_LINK_REGEX.lastIndex = 0;

  const promoCount = countPromoSignals(text);

  // WhatsApp group link = always check
  if (hasLink) {
    return { needs: true, reason: 'contains_group_link' };
  }

  // Multiple promo signals without a link = check
  if (promoCount >= 2) {
    return { needs: true, reason: `${promoCount}_promo_signals` };
  }

  // Single signal or none = not suspicious enough
  return { needs: false, reason: 'no_suspicious_signals' };
}

/**
 * LLM-based spam classification using Groq
 */
async function classifyWithLlm(text: string, groupName: string): Promise<{
  isSpam: boolean;
  confidence: number;
  reason: string;
}> {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    console.log(`[${new Date().toISOString()}] [Spam] No GROQ_API_KEY - falling back to conservative check`);
    return conservativeFallback(text);
  }

  const prompt = `You are a spam classifier for a Hebrew-speaking WhatsApp community group called "${groupName}".

Analyze this message and determine if it's SPAM or LEGITIMATE.

SPAM examples:
- Promoting external WhatsApp groups with invite links
- Unsolicited advertising or promotions
- Scam messages (fake investments, get-rich-quick schemes)
- Mass-sent promotional content

LEGITIMATE examples (NOT spam):
- Discussing crypto/bitcoin/investments as a conversation topic
- Sharing a relevant link in context of a discussion
- Asking about loans, mortgages, credit cards normally
- Job postings in a jobs group
- Sharing a related community group link that admins approved
- Normal conversation that happens to mention financial terms

Reply with ONLY a JSON object, no other text:
{"spam": true/false, "confidence": 0.0-1.0, "reason": "brief explanation"}

Message to classify:
"""
${text.substring(0, 500)}
"""`;

  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_SPAM_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 100,
        temperature: 0.1
      })
    });

    if (!response.ok) {
      console.error(`[${new Date().toISOString()}] [Spam] Groq API error: ${response.status}`);
      return conservativeFallback(text);
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();

    if (!content) {
      return conservativeFallback(text);
    }

    // Parse JSON from response (handle markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      console.error(`[${new Date().toISOString()}] [Spam] Could not parse LLM response: ${content}`);
      return conservativeFallback(text);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      isSpam: parsed.spam === true,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      reason: parsed.reason || 'unknown'
    };
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [Spam] LLM classification failed:`, error);
    return conservativeFallback(text);
  }
}

/**
 * Conservative fallback when LLM is unavailable.
 * Only flags messages with group links + promo signals (very high confidence).
 */
function conservativeFallback(text: string): { isSpam: boolean; confidence: number; reason: string } {
  WHATSAPP_GROUP_LINK_REGEX.lastIndex = 0;
  const hasLink = hasGroupLink(text);
  WHATSAPP_GROUP_LINK_REGEX.lastIndex = 0;
  const promoCount = countPromoSignals(text);

  if (hasLink && promoCount >= 1) {
    return { isSpam: true, confidence: 0.85, reason: 'group_link_with_promo_signals (fallback)' };
  }

  // Without LLM, don't flag anything else - better to miss spam than remove legit users
  return { isSpam: false, confidence: 0, reason: 'fallback_pass' };
}

async function isGroupAdmin(sock: WASocket, groupId: string, participantJid: string): Promise<boolean> {
  try {
    const metadata: GroupMetadata = await sock.groupMetadata(groupId);
    const participant = metadata.participants.find(p => p.id === participantJid);
    if (!participant) return false;
    return participant.admin === 'admin' || participant.admin === 'superadmin';
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [Spam] Failed to check admin status:`, error);
    return false;
  }
}

function isWhitelisted(participantJid: string): boolean {
  const phoneNumber = participantJid.replace('@s.whatsapp.net', '');
  return SPAM_WHITELIST.includes(phoneNumber) || SPAM_WHITELIST.includes(participantJid);
}

async function deleteMessage(sock: WASocket, groupId: string, messageKey: proto.IMessageKey): Promise<boolean> {
  try {
    await sock.sendMessage(groupId, { delete: messageKey });
    console.log(`[${new Date().toISOString()}] [Spam] Message deleted from ${groupId}`);
    return true;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [Spam] Failed to delete message:`, error);
    return false;
  }
}

async function removeUserFromGroup(sock: WASocket, groupId: string, participantJid: string, groupName: string): Promise<boolean> {
  try {
    await sock.groupParticipantsUpdate(groupId, [participantJid], 'remove');
    console.log(`[${new Date().toISOString()}] [Spam] Removed ${participantJid} from ${groupName}`);
    return true;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [Spam] Failed to remove user ${participantJid}:`, error);
    return false;
  }
}

async function sendWarning(sock: WASocket, groupId: string, participantJid: string, reason: string): Promise<void> {
  // Respect Shabbat - don't send warning messages during Shabbat
  if (isCurrentlyShabbat() || areGroupsAlreadyLocked()) {
    console.log(`[${new Date().toISOString()}] [Spam] Shabbat active - skipping warning message`);
    return;
  }

  try {
    const mentionTag = `@${participantJid.replace('@s.whatsapp.net', '')}`;
    await sock.sendMessage(groupId, {
      text: `⚠️ ${mentionTag} ההודעה שלך נמחקה.\nסיבה: ${reason}\n\nאם זו טעות, פנה לאדמין של הקבוצה. אזהרה נוספת תוביל להסרה מהקבוצה.`,
      mentions: [participantJid]
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [Spam] Failed to send warning:`, error);
  }
}

async function notifyAdmins(
  sock: WASocket,
  action: 'warning' | 'removal',
  groupName: string,
  participantJid: string,
  reason: string,
  confidence: number,
  messagePreview: string | null
): Promise<void> {
  if (SPAM_ADMIN_NOTIFY.length === 0) return;

  // Respect Shabbat
  if (isCurrentlyShabbat() || areGroupsAlreadyLocked()) {
    console.log(`[${new Date().toISOString()}] [Spam] Shabbat active - skipping admin notification`);
    return;
  }

  const senderPhone = participantJid.replace('@s.whatsapp.net', '');
  const actionHebrew = action === 'removal' ? 'הוסר מהקבוצה' : 'קיבל אזהרה';
  const preview = messagePreview ? messagePreview.substring(0, 150) : 'N/A';

  const notification = [
    `🛡️ *דוח ספאם - ${groupName}*`,
    ``,
    `*פעולה:* ${actionHebrew}`,
    `*משתמש:* ${senderPhone}`,
    `*סיבה:* ${reason}`,
    `*ביטחון:* ${Math.round(confidence * 100)}%`,
    `*תצוגה מקדימה:* ${preview}`,
  ].join('\n');

  for (const adminPhone of SPAM_ADMIN_NOTIFY) {
    try {
      const adminJid = adminPhone.includes('@') ? adminPhone : `${adminPhone}@s.whatsapp.net`;
      await sock.sendMessage(adminJid, { text: notification });
    } catch (error) {
      console.error(`[${new Date().toISOString()}] [Spam] Failed to notify admin ${adminPhone}:`, error);
    }
  }
}

function getGroupName(groupId: string): string {
  const group = ALLOWED_GROUPS.find(g => g.id === groupId);
  return group?.name || groupId;
}

function getWarningCount(participantJid: string): number {
  const record = warningTracker.get(participantJid);
  if (!record) return 0;

  // Reset if outside the warning window
  if (Date.now() - record.lastWarningTime > WARNING_WINDOW_MS) {
    warningTracker.delete(participantJid);
    return 0;
  }

  return record.count;
}

function addWarning(participantJid: string): number {
  const current = getWarningCount(participantJid);
  const newCount = current + 1;
  warningTracker.set(participantJid, { count: newCount, lastWarningTime: Date.now() });
  return newCount;
}

export interface SpamCheckResult {
  isSpam: boolean;
  reason: string | null;
  matchedContent: string | null;
  confidence: number;
}

export interface SpamAction {
  messageDeleted: boolean;
  userRemoved: boolean;
  userWarned: boolean;
  skippedReason: string | null;
}

/**
 * Check if a message is spam using LLM context analysis.
 * Pre-filters to avoid unnecessary LLM calls.
 */
export async function checkForSpam(text: string, groupId: string): Promise<SpamCheckResult> {
  if (!SPAM_DETECTION_ENABLED) {
    return { isSpam: false, reason: null, matchedContent: null, confidence: 0 };
  }

  // Pre-filter: does this message even need checking?
  const preFilter = needsLlmCheck(text);
  if (!preFilter.needs) {
    return { isSpam: false, reason: null, matchedContent: null, confidence: 0 };
  }

  console.log(`[${new Date().toISOString()}] [Spam] Pre-filter triggered: ${preFilter.reason} - sending to LLM`);

  // LLM-based classification
  const groupName = getGroupName(groupId);
  const classification = await classifyWithLlm(text, groupName);

  console.log(`[${new Date().toISOString()}] [Spam] LLM verdict: spam=${classification.isSpam}, confidence=${classification.confidence}, reason=${classification.reason}`);

  // Only act on high-confidence spam (>= 0.7)
  if (classification.isSpam && classification.confidence >= 0.7) {
    return {
      isSpam: true,
      reason: classification.reason,
      matchedContent: text.substring(0, 100),
      confidence: classification.confidence,
    };
  }

  return { isSpam: false, reason: null, matchedContent: null, confidence: classification.confidence };
}

/**
 * Handle a spam message with warning escalation:
 * - First offense: delete message + warn user
 * - Second offense (within 24h): delete message + remove user
 */
export async function handleSpamMessage(
  sock: WASocket,
  groupId: string,
  messageKey: proto.IMessageKey,
  participantJid: string,
  spamReason: string,
  matchedContent: string | null,
  confidence: number
): Promise<SpamAction> {
  const groupName = getGroupName(groupId);

  console.log(`[${new Date().toISOString()}] [Spam] Handling spam in ${groupName}`);
  console.log(`[${new Date().toISOString()}] [Spam] Reason: ${spamReason}`);
  console.log(`[${new Date().toISOString()}] [Spam] Confidence: ${confidence}`);
  console.log(`[${new Date().toISOString()}] [Spam] Sender: ${participantJid}`);

  // Check whitelist
  if (isWhitelisted(participantJid)) {
    console.log(`[${new Date().toISOString()}] [Spam] User is whitelisted - skipping`);
    return { messageDeleted: false, userRemoved: false, userWarned: false, skippedReason: 'whitelisted' };
  }

  // Check admin
  const isAdmin = await isGroupAdmin(sock, groupId, participantJid);
  if (isAdmin) {
    console.log(`[${new Date().toISOString()}] [Spam] User is group admin - skipping`);
    return { messageDeleted: false, userRemoved: false, userWarned: false, skippedReason: 'admin' };
  }

  // Always delete the spam message
  const messageDeleted = await deleteMessage(sock, groupId, messageKey);

  // Warning escalation
  const warningCount = getWarningCount(participantJid);

  // Very high confidence (>= 0.9) = skip warning, remove immediately
  if (confidence >= 0.9) {
    console.log(`[${new Date().toISOString()}] [Spam] Very high confidence (${confidence}) - removing immediately`);
    const userRemoved = await removeUserFromGroup(sock, groupId, participantJid, groupName);
    await notifyAdmins(sock, 'removal', groupName, participantJid, spamReason, confidence, matchedContent);
    return { messageDeleted, userRemoved, userWarned: false, skippedReason: null };
  }

  // First offense = warn
  if (warningCount === 0) {
    const newCount = addWarning(participantJid);
    console.log(`[${new Date().toISOString()}] [Spam] First offense - warning user (warning #${newCount})`);
    await sendWarning(sock, groupId, participantJid, spamReason);
    await notifyAdmins(sock, 'warning', groupName, participantJid, spamReason, confidence, matchedContent);
    return { messageDeleted, userRemoved: false, userWarned: true, skippedReason: null };
  }

  // Second+ offense = remove
  console.log(`[${new Date().toISOString()}] [Spam] Repeat offense (warning #${warningCount}) - removing user`);
  const userRemoved = await removeUserFromGroup(sock, groupId, participantJid, groupName);
  await notifyAdmins(sock, 'removal', groupName, participantJid, spamReason, confidence, matchedContent);
  return { messageDeleted, userRemoved, userWarned: false, skippedReason: null };
}

export function getSpamDetectionStatus(): {
  enabled: boolean;
  whitelistCount: number;
  activeWarnings: number;
} {
  return {
    enabled: SPAM_DETECTION_ENABLED,
    whitelistCount: SPAM_WHITELIST.length,
    activeWarnings: warningTracker.size,
  };
}

export function isSpamDetectionEnabled(): boolean {
  return SPAM_DETECTION_ENABLED;
}
