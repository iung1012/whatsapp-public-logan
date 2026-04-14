/**
 * שבוע טוב Summary Script
 *
 * One-time script to send 48-hour weekend summaries to each WhatsApp group.
 * Each group gets its own unique summary in Hebrew with TTS voice.
 *
 * IMPORTANT: Stop the bot before running this script to avoid 440 session conflicts.
 * Usage: npm run shavua-tov
 */

import 'dotenv/config';
import { initSupabase } from '../supabase';
import { getDb } from '../db';
import { connectToWhatsApp, getSocket, isConnected, isStable, waitForStability } from '../connection';
import { ALLOWED_GROUPS } from '../config';
import { textToSpeech, isElevenLabsEnabled } from '../services/elevenlabs';
import { markdownToWhatsApp } from '../utils/formatting';
import { saveMessage } from '../supabase';
import { WhatsAppMessage } from '../types';
import { areGroupsAlreadyLocked } from '../shabbatLocker';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================
// Custom prompts for שבוע טוב weekend summary
// ============================================================

const SHAVUA_TOV_TEXT_PROMPT = `התפקיד שלך הוא ליצור סיכום סופ"ש (48 שעות אחרונות) של דיונים שהתקיימו בקבוצת וואצאפ בצורה תמציתית, חמה ומעניינת. הסיכום צריך להיות בעברית.

חשוב מאוד: הסיכום חייב להתחיל עם הברכה הבאה בדיוק:
🕯️ *שבוע טוב ובשורות טובות בעזרת השם יתברך!* 🕯️

הפורמט של הסיכום אחרי הברכה:

📊 סיכום סופ"ש - מה פספסתם?

🔥 נושאים עיקריים: רשום אך ורק נושאים מעניינים ומי העלה אותם.
- אם יש מספר טלפון בפורמט @972XXXXXXXXX - השתמש בו לתיוג
- אם אין מספר טלפון - השתמש בשם המשתמש בלבד (בלי @)
- לעולם אל תמציא מספרים או תשתמש במספרים שלא מתחילים ב-972

לגבי קיצור התוכן - לא צריך לציין כל דבר, רק את מה שהכי מעניין.

💬 דיונים בולטים: תאר בקצרה את הלך הדיונים. בקיצור נמרץ, בלי להאריך בדברים ואך ורק מה שרלוונטי לכולם ומעניין.

סיים עם משפט מעודד וחיובי לשבוע החדש.

קריטי: מקסימום 900 תווים! אם חרג - קצר ונסה שוב.

הערה: הכל צריך להיות מיושר לימין RTL. כל משפט חייב להתחיל בעברית כדי לשמור על הסדר.`;

const SHAVUA_TOV_VOICE_PROMPT = `התפקיד שלך הוא ליצור סיכום סופ"ש קולי של דיונים שהתקיימו בקבוצת וואצאפ. הסיכום צריך להיות בעברית טבעית, מתאים להקראה קולית.

חשוב מאוד: התחל עם "שבוע טוב ובשורות טובות בעזרת השם יתברך!"

חשוב מאוד:
- אל תכלול מספרי טלפון
- אל תכלול תיוגים או מזהים
- אל תכלול אימוג'ים
- אל תכלול סימנים מיוחדים
- כתוב בשפה זורמת וטבעית כאילו אתה מספר לחבר

פורמט:
"שבוע טוב ובשורות טובות בעזרת השם יתברך! הנה סיכום מה שקרה בקבוצה בסופ״ש. דיברנו על [נושא], ו[שם] העלה נקודה מעניינת בנוגע ל[תוכן]. בנוסף, היה דיון על [נושא נוסף]... שיהיה לכולם שבוע מוצלח!"

מקסימום 600 תווים. קצר וקולח.`;

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

// ============================================================
// Helper functions
// ============================================================

/**
 * Check if a number looks like a valid Israeli phone number
 */
function isValidIsraeliPhone(number: string | null): boolean {
  if (!number) return false;
  return /^972\d{9}$/.test(number);
}

/**
 * Get messages from the last 48 hours for a group
 */
async function getGroupMessages48Hours(
  groupId: string
): Promise<Array<{ senderName: string | null; senderNumber: string | null; body: string | null }>> {
  const fortyEightHoursAgo = Math.floor((Date.now() - 48 * 60 * 60 * 1000) / 1000);

  try {
    const sql = getDb();
    const rows = await sql<{ sender_name: string; sender_number: string; body: string }[]>`
      SELECT sender_name, sender_number, body
      FROM whatsapp_messages
      WHERE chat_id = ${groupId}
        AND is_content = true
        AND timestamp >= ${fortyEightHoursAgo}
      ORDER BY timestamp ASC
      LIMIT 1000
    `;
    return rows.map(m => ({ senderName: m.sender_name, senderNumber: m.sender_number, body: m.body }));
  } catch (err) {
    console.error('[SHAVUA-TOV] Exception fetching group messages:', err);
    return [];
  }
}

/**
 * Build the prompt with messages for Claude
 */
function buildPrompt(
  messages: Array<{ senderName: string | null; senderNumber: string | null; body: string | null }>
): string {
  const formattedMessages = messages
    .filter(m => m.body)
    .map(m => {
      const sender = m.senderName || 'Unknown';
      const number = isValidIsraeliPhone(m.senderNumber) ? ` (@${m.senderNumber})` : '';
      return `${sender}${number}: ${m.body}`;
    })
    .join('\n');

  return `הנה ההודעות מ-48 השעות האחרונות (סופ"ש):\n<discussions>\n${formattedMessages}\n</discussions>`;
}

/**
 * Call Claude API with a custom system prompt
 */
async function callClaudeCustom(systemPrompt: string, userMessage: string, maxTokens: number): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[SHAVUA-TOV] ANTHROPIC_API_KEY not configured');
    return null;
  }

  try {
    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        max_tokens: maxTokens
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[SHAVUA-TOV] Claude API error ${response.status}: ${errorText}`);
      return null;
    }

    const data = await response.json() as any;
    const textContent = data.content?.find((c: any) => c.type === 'text');
    return textContent?.text || null;
  } catch (error) {
    console.error('[SHAVUA-TOV] Claude request failed:', error);
    return null;
  }
}

/**
 * Send a text message to a group
 */
async function sendTextMessage(groupId: string, message: string): Promise<boolean> {
  const sock = getSocket();
  if (!sock) {
    console.error('[SHAVUA-TOV] Socket not available');
    return false;
  }

  try {
    const formattedMessage = markdownToWhatsApp(message);
    const result = await sock.sendMessage(groupId, { text: formattedMessage });

    // Log to Supabase
    const groupConfig = ALLOWED_GROUPS.find(g => g.id === groupId);
    const outgoingMessage: WhatsAppMessage = {
      id: result?.key?.id || `shavua-tov-${Date.now()}`,
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
    console.error('[SHAVUA-TOV] Error sending text message:', error);
    return false;
  }
}

/**
 * Send a voice message to a group
 */
async function sendVoiceMessage(groupId: string, audioBuffer: Buffer): Promise<boolean> {
  const sock = getSocket();
  if (!sock) {
    console.error('[SHAVUA-TOV] Socket not available');
    return false;
  }

  try {
    const result = await sock.sendMessage(groupId, {
      audio: audioBuffer,
      mimetype: 'audio/mpeg',
      ptt: true
    });

    // Log to Supabase
    const groupConfig = ALLOWED_GROUPS.find(g => g.id === groupId);
    const outgoingMessage: WhatsAppMessage = {
      id: result?.key?.id || `shavua-tov-voice-${Date.now()}`,
      chat_id: groupId,
      chat_name: groupConfig?.name || 'Unknown Group',
      sender_name: 'Logan (Bot)',
      sender_number: process.env.BOT_PHONE_NUMBER || null,
      message_type: 'audio',
      body: '[שבוע טוב Voice Summary]',
      timestamp: Math.floor(Date.now() / 1000),
      from_me: true,
      is_group: true,
      is_content: true
    };
    await saveMessage(outgoingMessage);

    return true;
  } catch (error) {
    console.error('[SHAVUA-TOV] Error sending voice message:', error);
    return false;
  }
}

/**
 * Generate TTS with presence keepalive
 */
async function generateTTSWithKeepalive(voiceText: string, targetId: string): Promise<Buffer | null> {
  const sock = getSocket();
  if (!sock) return await textToSpeech(voiceText);

  let keepAliveInterval: NodeJS.Timeout | null = null;

  try {
    await sock.sendPresenceUpdate('recording', targetId);

    keepAliveInterval = setInterval(async () => {
      try {
        await sock.sendPresenceUpdate('recording', targetId);
      } catch {}
    }, 10000);

    return await textToSpeech(voiceText);
  } finally {
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    try {
      await sock.sendPresenceUpdate('paused', targetId);
    } catch {}
  }
}

// ============================================================
// Main script
// ============================================================

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log(`[${new Date().toISOString()}] שבוע טוב Summary Script Starting...`);
  console.log('='.repeat(60));

  // Shabbat safety check - read cache file directly since shabbatLocker module
  // variables aren't initialized without startShabbatLocker()
  if (process.env.SHABBAT_ENABLED === 'true') {
    // Check lock state file
    if (areGroupsAlreadyLocked()) {
      console.error('[SHAVUA-TOV] BLOCKED: Groups are locked. Cannot send messages.');
      process.exit(1);
    }

    // Check cached Shabbat times directly from file
    const cacheFile = path.join(process.cwd(), 'shabbat_times_cache.json');
    try {
      if (fs.existsSync(cacheFile)) {
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        const now = new Date();
        const unlockTime = cache.unlockTime ? new Date(cache.unlockTime) : null;
        const lockTime = cache.lockTime ? new Date(cache.lockTime) : null;

        if (lockTime && unlockTime && now >= lockTime && now < unlockTime) {
          console.error(`[SHAVUA-TOV] BLOCKED: Currently Shabbat (unlock at ${unlockTime.toISOString()}). Cannot send messages.`);
          process.exit(1);
        }

        if (!lockTime && unlockTime && now < unlockTime) {
          console.error(`[SHAVUA-TOV] BLOCKED: Currently Shabbat (unlock at ${unlockTime.toISOString()}). Cannot send messages.`);
          process.exit(1);
        }

        console.log(`[SHAVUA-TOV] Shabbat check passed - unlock was at ${unlockTime?.toISOString() || 'N/A'}, now is ${now.toISOString()}`);
      } else {
        console.log('[SHAVUA-TOV] No Shabbat cache file found, proceeding');
      }
    } catch (err) {
      console.warn('[SHAVUA-TOV] Could not read Shabbat cache, proceeding:', err);
    }
  }

  // Check required env vars
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[SHAVUA-TOV] ANTHROPIC_API_KEY not configured');
    process.exit(1);
  }

  // Initialize Supabase
  try {
    initSupabase();
  } catch (err) {
    console.error('[SHAVUA-TOV] Failed to initialize Supabase:', err);
    process.exit(1);
  }

  // Connect to WhatsApp
  console.log('[SHAVUA-TOV] Connecting to WhatsApp...');
  try {
    await connectToWhatsApp(() => {
      // No message handler needed for this one-off script
    });
  } catch (err) {
    console.error('[SHAVUA-TOV] Failed to connect to WhatsApp:', err);
    process.exit(1);
  }

  // Wait for stable connection
  console.log('[SHAVUA-TOV] Waiting for stable connection...');
  const stable = await waitForStability(30000);
  if (!stable) {
    console.error('[SHAVUA-TOV] Connection did not stabilize within 30 seconds');
    process.exit(1);
  }

  console.log('[SHAVUA-TOV] Connection stable. Starting summaries...');

  // Get groups only (not channels), optionally filtered by name args
  const filterArgs = process.argv.slice(2);
  let groups = ALLOWED_GROUPS.filter(g => g.id.endsWith('@g.us'));

  if (filterArgs.length > 0) {
    groups = groups.filter(g => filterArgs.some(arg => g.name.includes(arg)));
    console.log(`[SHAVUA-TOV] Filtered to ${groups.length} groups: ${groups.map(g => g.name).join(', ')}`);
  } else {
    console.log(`[SHAVUA-TOV] Processing all ${groups.length} groups`);
  }

  let successCount = 0;
  let skipCount = 0;

  for (const group of groups) {
    console.log(`\n${'─'.repeat(40)}`);
    console.log(`[SHAVUA-TOV] Processing: ${group.name}`);

    // Double-check lock state before each send
    if (process.env.SHABBAT_ENABLED === 'true') {
      if (areGroupsAlreadyLocked()) {
        console.error('[SHAVUA-TOV] BLOCKED: Groups locked mid-run. Stopping.');
        break;
      }
    }

    // Check connection
    if (!isConnected() || !isStable()) {
      console.error('[SHAVUA-TOV] Connection lost. Waiting up to 120s for reconnection...');
      const reconnected = await waitForStability(120000);
      if (!reconnected) {
        console.error('[SHAVUA-TOV] Could not reconnect. Aborting.');
        break;
      }
      console.log('[SHAVUA-TOV] Reconnected successfully, continuing...');
    }

    // Step 1: Get 48h messages
    const messages = await getGroupMessages48Hours(group.id);
    if (messages.length === 0) {
      console.log(`[SHAVUA-TOV] No messages in ${group.name}, skipping`);
      skipCount++;
      continue;
    }
    console.log(`[SHAVUA-TOV] Found ${messages.length} messages`);

    // Step 2: Build prompt
    const prompt = buildPrompt(messages);

    // Step 3: Generate text summary
    console.log('[SHAVUA-TOV] Generating text summary...');
    const textSummary = await callClaudeCustom(SHAVUA_TOV_TEXT_PROMPT, prompt, 500);
    if (!textSummary) {
      console.error(`[SHAVUA-TOV] Failed to generate text summary for ${group.name}`);
      continue;
    }
    console.log(`[SHAVUA-TOV] Text summary: ${textSummary.length} chars`);

    // Step 4: Send text
    const textSent = await sendTextMessage(group.id, textSummary);
    if (!textSent) {
      console.error(`[SHAVUA-TOV] Failed to send text to ${group.name}`);
      continue;
    }
    console.log(`[SHAVUA-TOV] Text sent to ${group.name}`);

    // Step 5: Generate and send voice
    if (isElevenLabsEnabled()) {
      console.log('[SHAVUA-TOV] Generating voice summary...');
      const voiceSummary = await callClaudeCustom(SHAVUA_TOV_VOICE_PROMPT, prompt, 350);

      if (voiceSummary) {
        console.log(`[SHAVUA-TOV] Voice summary: ${voiceSummary.length} chars`);

        const audioBuffer = await generateTTSWithKeepalive(voiceSummary, group.id);

        if (audioBuffer) {
          console.log(`[SHAVUA-TOV] TTS audio: ${audioBuffer.length} bytes`);
          await new Promise(resolve => setTimeout(resolve, 2000));

          const voiceSent = await sendVoiceMessage(group.id, audioBuffer);
          if (voiceSent) {
            console.log(`[SHAVUA-TOV] Voice sent to ${group.name}`);
          } else {
            console.error(`[SHAVUA-TOV] Failed to send voice to ${group.name}`);
          }
        } else {
          console.error(`[SHAVUA-TOV] TTS generation failed for ${group.name}`);
        }
      } else {
        console.error(`[SHAVUA-TOV] Failed to generate voice summary for ${group.name}`);
      }
    } else {
      console.log('[SHAVUA-TOV] Voice skipped - ElevenLabs not configured');
    }

    successCount++;

    // Wait between groups to avoid rate limiting
    if (groups.indexOf(group) < groups.length - 1) {
      console.log('[SHAVUA-TOV] Waiting 10s before next group...');
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[SHAVUA-TOV] Done! ${successCount} groups sent, ${skipCount} skipped (no messages)`);
  console.log('='.repeat(60));

  // Give a moment for any pending I/O
  await new Promise(resolve => setTimeout(resolve, 3000));
  process.exit(0);
}

// Run
main().catch((err) => {
  console.error('[SHAVUA-TOV] Fatal error:', err);
  process.exit(1);
});
