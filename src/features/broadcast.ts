/**
 * News Broadcast Feature
 * Sends messages (with optional images) to all monitored groups
 */

import { isConnected, isStable, getSocket } from '../connection';
import { ALLOWED_GROUPS } from '../config';
import { saveMessage } from '../supabase';
import { WhatsAppMessage } from '../types';
import { markdownToWhatsApp } from '../utils/formatting';
import { isCurrentlyShabbat, areGroupsAlreadyLocked } from '../shabbatLocker';

const DELAY_BETWEEN_GROUPS_MS = 10000; // 10 seconds between groups

interface BroadcastResult {
  groupId: string;
  groupName: string;
  success: boolean;
  error?: string;
}

/**
 * Send a broadcast message to all monitored groups
 */
export async function sendBroadcast(
  text: string,
  imageUrl?: string
): Promise<{ success: boolean; sentTo: number; results: BroadcastResult[] }> {
  console.log(`[BROADCAST] Starting broadcast to ${ALLOWED_GROUPS.length} groups`);

  // CRITICAL: Block broadcasts during Shabbat
  if (process.env.SHABBAT_ENABLED === 'true') {
    if (isCurrentlyShabbat() || areGroupsAlreadyLocked()) {
      console.log('[BROADCAST] 🕯️ SHABBAT MODE - Blocking broadcast');
      return {
        success: false,
        sentTo: 0,
        results: ALLOWED_GROUPS.map(g => ({
          groupId: g.id,
          groupName: g.name,
          success: false,
          error: 'Blocked: Shabbat mode active'
        }))
      };
    }
  }

  // Check WhatsApp connection
  if (!isConnected() || !isStable()) {
    console.error('[BROADCAST] WhatsApp not connected');
    return {
      success: false,
      sentTo: 0,
      results: ALLOWED_GROUPS.map(g => ({
        groupId: g.id,
        groupName: g.name,
        success: false,
        error: 'WhatsApp not connected'
      }))
    };
  }

  const sock = getSocket();
  if (!sock) {
    console.error('[BROADCAST] Socket not available');
    return {
      success: false,
      sentTo: 0,
      results: ALLOWED_GROUPS.map(g => ({
        groupId: g.id,
        groupName: g.name,
        success: false,
        error: 'Socket not available'
      }))
    };
  }

  const results: BroadcastResult[] = [];
  let sentCount = 0;

  for (let i = 0; i < ALLOWED_GROUPS.length; i++) {
    const group = ALLOWED_GROUPS[i];

    try {
      let result;
      let messageType = 'text';

      // Convert markdown formatting to WhatsApp formatting (** → *, etc.)
      const formattedText = text ? markdownToWhatsApp(text) : '';

      if (imageUrl) {
        // Send image with caption
        console.log(`[BROADCAST] Sending image to ${group.name}`);
        result = await sock.sendMessage(group.id, {
          image: { url: imageUrl },
          caption: formattedText || undefined
        });
        messageType = 'image';
      } else {
        // Send text only
        console.log(`[BROADCAST] Sending text to ${group.name}`);
        result = await sock.sendMessage(group.id, { text: formattedText });
      }

      // Log to Supabase
      const outgoingMessage: WhatsAppMessage = {
        id: result?.key?.id || `broadcast-${Date.now()}-${i}`,
        chat_id: group.id,
        chat_name: group.name,
        sender_name: 'Logan (Bot)',
        sender_number: process.env.BOT_PHONE_NUMBER || null,
        message_type: messageType,
        body: imageUrl ? `${text || ''}\n[image: ${imageUrl}]` : text,
        timestamp: Math.floor(Date.now() / 1000),
        from_me: true,
        is_group: true,
        is_content: true
      };
      await saveMessage(outgoingMessage);

      console.log(`[BROADCAST] Sent to ${group.name}`);
      results.push({
        groupId: group.id,
        groupName: group.name,
        success: true
      });
      sentCount++;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[BROADCAST] Failed to send to ${group.name}:`, errorMsg);
      results.push({
        groupId: group.id,
        groupName: group.name,
        success: false,
        error: errorMsg
      });
      // Continue to next group even if this one failed
    }

    // Wait between groups (except for the last one)
    if (i < ALLOWED_GROUPS.length - 1) {
      console.log(`[BROADCAST] Waiting ${DELAY_BETWEEN_GROUPS_MS / 1000}s before next group...`);
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_GROUPS_MS));
    }
  }

  console.log(`[BROADCAST] Complete - sent to ${sentCount}/${ALLOWED_GROUPS.length} groups`);

  return {
    success: sentCount > 0,
    sentTo: sentCount,
    results
  };
}
