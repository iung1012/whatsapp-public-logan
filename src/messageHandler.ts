import { WASocket, proto, downloadMediaMessage } from '@whiskeysockets/baileys';
import { WhatsAppMessage } from './types';
import { ALLOWED_GROUP_IDS, ALLOWED_GROUPS, CONTENT_MESSAGE_TYPES } from './config';
import { saveMessage, getConversationHistory } from './supabase';
import { isBotMentioned, isReplyToBot, sendMentionWebhook, logMentionWebhookConfig } from './mentionWebhook';
import { getBotJid, getBotLid } from './connection';
import { checkForSpam, handleSpamMessage, isSpamDetectionEnabled } from './spamDetector';
import { isJoinRequestProcessingEnabled } from './joinRequestProcessor';
import { handleMention, handleVoiceMention, isMentionResponseEnabled, logMentionResponseConfig } from './features/mention-response';
import { transcribeAudio, isVoiceTranscriptionEnabled, formatVoiceTranscription } from './services/whisper';
import { isAuthorizedForVoice, containsLoganTrigger, removeLoganTrigger, isFreeChatGroup, containsLoganTextTrigger, removeLoganFromText, isTextTriggerAllowed } from './utils/agent-triggers';
import { hasImage, downloadImage, cleanupImage, DownloadedImage } from './utils/image-downloader';

type WAMessage = proto.IWebMessageInfo;

/**
 * Extract the message type from a WhatsApp message
 */
function getMessageType(message: WAMessage, debug: boolean = false): string {
  const msg = message.message;
  if (!msg) return 'no_message';

  if (msg.conversation || msg.extendedTextMessage) return 'text';
  if (msg.imageMessage) return 'image';
  if (msg.videoMessage) return 'video';
  if (msg.audioMessage) return 'audio';
  if (msg.documentMessage) return 'document';
  if (msg.stickerMessage) return 'sticker';
  if (msg.contactMessage || msg.contactsArrayMessage) return 'contact';
  if (msg.locationMessage) return 'location';
  if (msg.liveLocationMessage) return 'live_location';
  if (msg.reactionMessage) return 'reaction';
  if (msg.pollCreationMessage || msg.pollCreationMessageV2 || msg.pollCreationMessageV3) return 'poll';
  if (msg.pollUpdateMessage) return 'poll_vote';
  if (msg.protocolMessage) return 'protocol';
  if (msg.viewOnceMessage || msg.viewOnceMessageV2) return 'view_once';
  if (msg.editedMessage) return 'edited';
  if (msg.buttonsMessage || msg.buttonsResponseMessage) return 'button';
  if (msg.listMessage || msg.listResponseMessage) return 'list';
  if (msg.templateMessage || msg.templateButtonReplyMessage) return 'template';
  if (msg.orderMessage) return 'order';
  if (msg.productMessage) return 'product';
  if (msg.invoiceMessage) return 'invoice';
  if (msg.groupInviteMessage) return 'group_invite';
  if (msg.interactiveMessage) return 'interactive';
  if (msg.interactiveResponseMessage) return 'interactive_response';
  if (msg.senderKeyDistributionMessage) return 'key_distribution';
  if (msg.deviceSentMessage) return 'device_sent';
  if (msg.bcallMessage) return 'call';
  if (msg.callLogMesssage) return 'call_log';
  if (msg.messageHistoryBundle) return 'history_bundle';
  if (msg.encReactionMessage) return 'encrypted_reaction';
  if (msg.keepInChatMessage) return 'keep_in_chat';
  if (msg.pinInChatMessage) return 'pin';
  if (msg.ptvMessage) return 'video_note';
  if (msg.scheduledCallCreationMessage) return 'scheduled_call';
  if (msg.eventMessage) return 'event';

  // Check for messageContextInfo only - this is often just metadata
  if (msg.messageContextInfo && Object.keys(msg).length === 1) return 'context_only';

  if (msg.ephemeralMessage) {
    // Ephemeral messages wrap other message types - extract the inner type
    const inner = msg.ephemeralMessage.message;
    if (inner?.conversation || inner?.extendedTextMessage) return 'text';
    if (inner?.imageMessage) return 'image';
    if (inner?.videoMessage) return 'video';
    if (inner?.audioMessage) return 'audio';
    if (inner?.stickerMessage) return 'sticker';
    if (inner?.reactionMessage) return 'reaction';
    if (inner?.pollCreationMessage || inner?.pollCreationMessageV2 || inner?.pollCreationMessageV3) return 'poll';
    return 'ephemeral';
  }

  // Log unknown types for debugging (only once per type)
  if (debug) {
    const keys = Object.keys(msg).filter(k => k !== 'messageContextInfo');
    console.log(`[DEBUG] Unknown message type. Keys: ${keys.join(', ')}`);
  }

  return 'unknown';
}

/**
 * Extract the text body from a WhatsApp message
 */
function getMessageBody(message: WAMessage): string | null {
  const msg = message.message;
  if (!msg) return null;

  // Text messages
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;

  // Media with captions
  if (msg.imageMessage?.caption) return msg.imageMessage.caption;
  if (msg.videoMessage?.caption) return msg.videoMessage.caption;
  if (msg.documentMessage?.caption) return msg.documentMessage.caption;
  if (msg.audioMessage) return '[audio]';

  // Sticker - describe it
  if (msg.stickerMessage) return '[sticker]';

  // Reaction - extract the emoji
  if (msg.reactionMessage?.text) return msg.reactionMessage.text;

  // Poll creation - extract question and options
  if (msg.pollCreationMessage) {
    const poll = msg.pollCreationMessage;
    const options = poll.options?.map(o => o.optionName).join(', ') || '';
    return `[poll] ${poll.name || ''}${options ? `: ${options}` : ''}`;
  }
  if (msg.pollCreationMessageV2) {
    const poll = msg.pollCreationMessageV2;
    const options = poll.options?.map(o => o.optionName).join(', ') || '';
    return `[poll] ${poll.name || ''}${options ? `: ${options}` : ''}`;
  }
  if (msg.pollCreationMessageV3) {
    const poll = msg.pollCreationMessageV3;
    const options = poll.options?.map(o => o.optionName).join(', ') || '';
    return `[poll] ${poll.name || ''}${options ? `: ${options}` : ''}`;
  }

  // Poll update (vote)
  if (msg.pollUpdateMessage) return '[poll vote]';

  // Contact message
  if (msg.contactMessage) {
    return `[contact] ${msg.contactMessage.displayName || ''}`;
  }

  // Location message
  if (msg.locationMessage) {
    const loc = msg.locationMessage;
    return `[location] ${loc.name || loc.address || `${loc.degreesLatitude},${loc.degreesLongitude}`}`;
  }

  // Live location
  if (msg.liveLocationMessage) {
    return '[live location]';
  }

  // View once messages
  if (msg.viewOnceMessage?.message) {
    const innerMsg = msg.viewOnceMessage.message;
    if (innerMsg.imageMessage?.caption) return innerMsg.imageMessage.caption;
    if (innerMsg.videoMessage?.caption) return innerMsg.videoMessage.caption;
    if (innerMsg.imageMessage) return '[view once image]';
    if (innerMsg.videoMessage) return '[view once video]';
  }
  if (msg.viewOnceMessageV2?.message) {
    const innerMsg = msg.viewOnceMessageV2.message;
    if (innerMsg.imageMessage?.caption) return innerMsg.imageMessage.caption;
    if (innerMsg.videoMessage?.caption) return innerMsg.videoMessage.caption;
    if (innerMsg.imageMessage) return '[view once image]';
    if (innerMsg.videoMessage) return '[view once video]';
  }

  // Edited message - try to extract from editedMessage
  if (msg.editedMessage?.message) {
    const edited = msg.editedMessage.message;
    if (edited.protocolMessage?.editedMessage?.conversation) {
      return edited.protocolMessage.editedMessage.conversation;
    }
    if (edited.protocolMessage?.editedMessage?.extendedTextMessage?.text) {
      return edited.protocolMessage.editedMessage.extendedTextMessage.text;
    }
  }

  // Button response
  if (msg.buttonsResponseMessage?.selectedButtonId) {
    return `[button] ${msg.buttonsResponseMessage.selectedDisplayText || msg.buttonsResponseMessage.selectedButtonId}`;
  }

  // List response
  if (msg.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return `[list] ${msg.listResponseMessage.title || msg.listResponseMessage.singleSelectReply.selectedRowId}`;
  }

  // Template button reply
  if (msg.templateButtonReplyMessage?.selectedId) {
    return `[template] ${msg.templateButtonReplyMessage.selectedDisplayText || msg.templateButtonReplyMessage.selectedId}`;
  }

  // Document without caption - show filename
  if (msg.documentMessage?.fileName) {
    return `[document] ${msg.documentMessage.fileName}`;
  }

  // Image/video without caption
  if (msg.imageMessage) return '[image]';
  if (msg.videoMessage) return '[video]';

  return null;
}

/**
 * Get the chat name - group/channel name from allowed list, or 'DM' for direct messages
 */
function getChatName(chatId: string): string {
  // Check if it's a known group or channel
  const group = ALLOWED_GROUPS.find(g => g.id === chatId);
  if (group) return group.name;

  // For DMs, return 'DM' instead of 'Unknown Group'
  if (chatId.endsWith('@s.whatsapp.net') || chatId.endsWith('@lid')) {
    return 'DM';
  }

  // For channels not in list
  if (chatId.endsWith('@newsletter')) {
    return 'Unknown Channel';
  }

  return 'Unknown Group';
}

/**
 * Extract mentioned JIDs from a WhatsApp message
 */
function getMentionedJids(message: WAMessage): string[] | null {
  const msg = message.message;
  if (!msg) return null;

  // Check extendedTextMessage for mentions (most common)
  if (msg.extendedTextMessage?.contextInfo?.mentionedJid) {
    return msg.extendedTextMessage.contextInfo.mentionedJid;
  }

  // Check ephemeral messages
  if (msg.ephemeralMessage?.message?.extendedTextMessage?.contextInfo?.mentionedJid) {
    return msg.ephemeralMessage.message.extendedTextMessage.contextInfo.mentionedJid;
  }

  // Check image/video captions with mentions
  if (msg.imageMessage?.contextInfo?.mentionedJid) {
    return msg.imageMessage.contextInfo.mentionedJid;
  }
  if (msg.videoMessage?.contextInfo?.mentionedJid) {
    return msg.videoMessage.contextInfo.mentionedJid;
  }

  return null;
}

/**
 * Get the participant JID of the message being replied to (if this is a reply)
 */
function getReplyToParticipant(message: WAMessage): string | null {
  const msg = message.message;
  if (!msg) return null;

  // Check extendedTextMessage for reply context
  if (msg.extendedTextMessage?.contextInfo?.participant) {
    return msg.extendedTextMessage.contextInfo.participant;
  }

  // Check ephemeral messages
  if (msg.ephemeralMessage?.message?.extendedTextMessage?.contextInfo?.participant) {
    return msg.ephemeralMessage.message.extendedTextMessage.contextInfo.participant;
  }

  // Check image/video replies
  if (msg.imageMessage?.contextInfo?.participant) {
    return msg.imageMessage.contextInfo.participant;
  }
  if (msg.videoMessage?.contextInfo?.participant) {
    return msg.videoMessage.contextInfo.participant;
  }

  return null;
}

/**
 * Get the quoted message text (the message being replied to)
 */
function getQuotedMessageText(message: WAMessage): string | null {
  const msg = message.message;
  if (!msg) return null;

  // Helper to extract text from a quoted message
  const extractQuotedText = (quotedMsg: any): string | null => {
    if (!quotedMsg) return null;
    if (quotedMsg.conversation) return quotedMsg.conversation;
    if (quotedMsg.extendedTextMessage?.text) return quotedMsg.extendedTextMessage.text;
    if (quotedMsg.imageMessage?.caption) return quotedMsg.imageMessage.caption;
    if (quotedMsg.videoMessage?.caption) return quotedMsg.videoMessage.caption;
    return null;
  };

  // Check extendedTextMessage for quoted message
  if (msg.extendedTextMessage?.contextInfo?.quotedMessage) {
    return extractQuotedText(msg.extendedTextMessage.contextInfo.quotedMessage);
  }

  // Check ephemeral messages
  if (msg.ephemeralMessage?.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
    return extractQuotedText(msg.ephemeralMessage.message.extendedTextMessage.contextInfo.quotedMessage);
  }

  // Check image/video replies
  if (msg.imageMessage?.contextInfo?.quotedMessage) {
    return extractQuotedText(msg.imageMessage.contextInfo.quotedMessage);
  }
  if (msg.videoMessage?.contextInfo?.quotedMessage) {
    return extractQuotedText(msg.videoMessage.contextInfo.quotedMessage);
  }

  return null;
}

/**
 * Check if a number looks like a real phone number based on country code patterns
 * WhatsApp LID format uses random long numbers that don't follow country code patterns
 */
function isValidPhoneNumber(number: string): boolean {
  // Must be digits only
  if (!/^\d+$/.test(number)) return false;

  // Real phone numbers are typically 10-13 digits
  // LID numbers are often 13-15 digits with no valid country code
  const len = number.length;

  // Common country code patterns (covers most of the world)
  // Format: [prefix, min_total_length, max_total_length]
  const countryPatterns: [string, number, number][] = [
    // North America
    ['1', 11, 11],      // US, Canada
    // Israel & Middle East
    ['972', 12, 12],    // Israel
    ['971', 12, 12],    // UAE
    ['970', 12, 12],    // Palestine
    ['966', 12, 12],    // Saudi Arabia
    ['965', 11, 11],    // Kuwait
    ['974', 11, 11],    // Qatar
    ['973', 11, 11],    // Bahrain
    ['962', 12, 12],    // Jordan
    ['961', 11, 11],    // Lebanon
    ['98', 12, 12],     // Iran
    ['90', 12, 12],     // Turkey
    // Europe
    ['44', 12, 12],     // UK
    ['49', 12, 13],     // Germany
    ['33', 11, 11],     // France
    ['39', 12, 13],     // Italy
    ['34', 11, 11],     // Spain
    ['31', 11, 11],     // Netherlands
    ['32', 11, 11],     // Belgium
    ['41', 11, 11],     // Switzerland
    ['43', 12, 13],     // Austria
    ['48', 11, 11],     // Poland
    ['380', 12, 12],    // Ukraine
    ['7', 11, 11],      // Russia
    // Asia
    ['86', 13, 13],     // China
    ['81', 12, 13],     // Japan
    ['82', 12, 12],     // South Korea
    ['91', 12, 12],     // India
    ['84', 11, 12],     // Vietnam
    ['66', 11, 11],     // Thailand
    ['65', 10, 10],     // Singapore
    ['60', 11, 12],     // Malaysia
    ['63', 12, 12],     // Philippines
    ['62', 12, 13],     // Indonesia
    // Australia/Oceania
    ['61', 11, 11],     // Australia
    ['64', 10, 11],     // New Zealand
    // South America
    ['55', 12, 13],     // Brazil
    ['54', 12, 13],     // Argentina
    ['52', 12, 12],     // Mexico
    ['57', 12, 12],     // Colombia
    // Africa
    ['27', 11, 11],     // South Africa
    ['20', 12, 12],     // Egypt
    ['234', 13, 13],    // Nigeria
  ];

  // Check if number matches any known country code pattern
  for (const [prefix, minLen, maxLen] of countryPatterns) {
    if (number.startsWith(prefix) && len >= minLen && len <= maxLen) {
      return true;
    }
  }

  // If no pattern matched and number is > 13 digits, it's likely a LID
  if (len > 13) return false;

  // For 10-13 digit numbers that don't match patterns, be conservative
  // Only accept if they start with common country code first digits
  const firstDigit = number[0];
  const firstTwo = number.substring(0, 2);

  // Valid country codes start with 1-9 (not 0)
  // And follow ITU-T E.164 patterns
  if (firstDigit === '0') return false;

  // Numbers starting with these are usually valid country codes
  const validStarts = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  if (!validStarts.includes(firstDigit)) return false;

  // Extra check: LID numbers often start with unusual patterns
  // If it's 13 digits and doesn't match known patterns, reject it
  if (len === 13 && !['86', '49', '39', '62', '55', '54', '23'].some(p => number.startsWith(p))) {
    return false;
  }

  return len >= 10 && len <= 12;
}

/**
 * Extract sender ID from participant JID
 * Returns the raw ID (phone number or LID) for consistent sender tracking
 */
function extractSenderId(input: string | null | undefined): string | null {
  if (!input) return null;

  // Get the part before @ (if it's a JID)
  const beforeAt = input.split('@')[0];
  if (!beforeAt) return null;

  // Handle device suffix (972501234567:12 -> 972501234567)
  const senderId = beforeAt.split(':')[0];

  return senderId || null;
}

/**
 * Check if a sender ID looks like a real phone number
 */
function looksLikePhoneNumber(id: string | null): boolean {
  if (!id) return false;
  return isValidPhoneNumber(id);
}

// Message types that should be skipped (system/internal messages)
const SKIP_MESSAGE_TYPES = new Set([
  'no_message',
  'protocol',
  'key_distribution',
  'context_only',
  'device_sent',
  'history_bundle',
  'keep_in_chat',
]);

/**
 * Process a single message and prepare it for storage
 */
function processMessage(message: WAMessage, chatId: string): WhatsAppMessage | null {
  const messageId = message.key.id;
  if (!messageId) return null;

  const isGroup = chatId.endsWith('@g.us');
  const isChannel = chatId.endsWith('@newsletter');
  const messageType = getMessageType(message, true); // Enable debug for unknown types

  // Skip system/internal message types
  if (SKIP_MESSAGE_TYPES.has(messageType)) {
    return null;
  }

  const body = getMessageBody(message);
  const fromMe = message.key.fromMe || false;

  // Extract sender identifier - Baileys provides multiple fields:
  // - participantPn / senderPn: actual phone number (when available)
  // - participant: may be LID (internal ID) or phone number
  const keyAny = message.key as any;

  // Try to get phone number from dedicated fields, fall back to participant/remoteJid
  let senderNumber: string | null = null;

  if (isGroup) {
    // For groups: try participantPn first (actual phone), fall back to participant
    if (keyAny.participantPn) {
      senderNumber = extractSenderId(keyAny.participantPn);
    } else {
      senderNumber = extractSenderId(message.key.participant);
    }
  } else {
    // For private chats: try senderPn first, fall back to remoteJid
    if (keyAny.senderPn) {
      senderNumber = extractSenderId(keyAny.senderPn);
    } else {
      senderNumber = extractSenderId(chatId);
    }
  }

  const senderName = message.pushName || null;

  // Log if we got a LID instead of a phone number (for debugging)
  if (senderNumber && !looksLikePhoneNumber(senderNumber)) {
    console.log(`[DEBUG] Sender ID is LID (not phone): ${senderNumber}, name: ${senderName}`);
  }

  // Skip unknown messages that have no body and no sender info
  // These are usually system messages we can't identify
  if (messageType === 'unknown' && !body && !senderName && !senderNumber) {
    return null;
  }

  // Timestamp is in seconds, convert to milliseconds if needed
  const timestamp = message.messageTimestamp
    ? typeof message.messageTimestamp === 'number'
      ? message.messageTimestamp
      : Number(message.messageTimestamp)
    : Math.floor(Date.now() / 1000);

  const isContent = CONTENT_MESSAGE_TYPES.has(messageType);

  // Store full message key as JSON for potential future reactions
  const messageKeyJson = JSON.stringify({
    remoteJid: message.key.remoteJid,
    fromMe: message.key.fromMe,
    id: message.key.id,
    participant: message.key.participant
  });

  // For reactions, extract the target message ID
  let reactedToId: string | null = null;
  if (message.message?.reactionMessage?.key?.id) {
    reactedToId = message.message.reactionMessage.key.id;
  }

  return {
    id: messageId,
    chat_id: chatId,
    chat_name: getChatName(chatId),
    sender_name: senderName,
    sender_number: senderNumber,
    message_type: messageType,
    body,
    timestamp,
    from_me: fromMe,
    is_group: isGroup || isChannel, // Treat channels like groups for storage
    is_content: isContent,
    message_key_json: messageKeyJson,
    reacted_to_id: reactedToId,
  };
}

/**
 * Setup message event listener on the socket
 */
export function setupMessageHandler(sock: WASocket): void {
  console.log(`[${new Date().toISOString()}] Setting up message handler...`);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // DEBUG: Log all incoming message events
    console.log(`[${new Date().toISOString()}] [DEBUG] messages.upsert: type=${type}, count=${messages.length}`);

    // Only process new messages (not history sync)
    if (type !== 'notify') {
      console.log(`[${new Date().toISOString()}] [DEBUG] Skipping non-notify type: ${type}`);
      return;
    }

    for (const message of messages) {
      try {
        const chatId = message.key.remoteJid;

        // DEBUG: Log every message received
        console.log(`[${new Date().toISOString()}] [DEBUG] Message received:`, {
          chatId: chatId,
          fromMe: message.key.fromMe,
          hasMessage: !!message.message,
          messageKeys: message.message ? Object.keys(message.message) : [],
          pushName: message.pushName
        });

        if (!chatId) {
          console.log(`[${new Date().toISOString()}] [DEBUG] Skipping: no chatId`);
          continue;
        }

        // Skip messages from the bot itself
        if (message.key.fromMe) {
          console.log(`[${new Date().toISOString()}] [DEBUG] Skipping: fromMe=true`);
          continue;
        }

        // Determine if this is a group, channel, or DM
        // Groups end with @g.us
        // Channels (newsletters) end with @newsletter
        // DMs can end with @s.whatsapp.net (phone number format) OR @lid (LID format)
        const isGroup = chatId.endsWith('@g.us');
        const isChannel = chatId.endsWith('@newsletter');
        const isDM = chatId.endsWith('@s.whatsapp.net') || chatId.endsWith('@lid');
        const dmEnabled = process.env.ENABLE_DM_WEBHOOK === 'true';

        // DEBUG: Log classification
        console.log(`[${new Date().toISOString()}] [DEBUG] Classification:`, {
          isGroup,
          isChannel,
          isDM,
          dmEnabled,
          chatIdSuffix: chatId.split('@')[1]
        });

        // Filter messages based on type
        if (isGroup || isChannel) {
          // For groups and channels: only process if in allowed list (or if no list configured)
          if (ALLOWED_GROUP_IDS.size > 0 && !ALLOWED_GROUP_IDS.has(chatId)) {
            console.log(`[${new Date().toISOString()}] [DEBUG] Skipping: ${isChannel ? 'channel' : 'group'} not in allowed list`);
            continue;
          }
        } else if (isDM) {
          // For DMs: only process if DM webhook is enabled
          if (!dmEnabled) {
            console.log(`[${new Date().toISOString()}] [DEBUG] Skipping: DM webhook disabled`);
            continue;
          }
          console.log(`[${new Date().toISOString()}] [DEBUG] DM passed filter, proceeding...`);
        } else {
          // Skip broadcast lists, status updates, etc.
          console.log(`[${new Date().toISOString()}] [DEBUG] Skipping: not group, channel, or DM (chatId: ${chatId})`);
          continue;
        }

        // Process the message
        const processedMessage = processMessage(message, chatId);
        if (!processedMessage) continue;

        // Skip protocol messages (read receipts, etc.)
        if (processedMessage.message_type === 'protocol') continue;

        // Spam detection (only for groups, not channels - only admins can post in channels)
        if (isGroup && !isChannel && processedMessage.body) {
          const spamCheck = await checkForSpam(processedMessage.body, chatId);

          if (spamCheck.isSpam) {
            // Get participant JID for removal
            const participantJid = message.key.participant || '';

            const spamAction = await handleSpamMessage(
              sock,
              chatId,
              message.key,
              participantJid,
              spamCheck.reason || 'unknown',
              spamCheck.matchedContent,
              spamCheck.confidence
            );

            // If spam was handled (not skipped due to admin/whitelist), skip saving this message
            if (!spamAction.skippedReason) {
              console.log(`[${new Date().toISOString()}] [Spam] Message handled - skipping save`);
              continue;
            }
          }
        }

        // Save to Supabase (both groups and DMs)
        if (isDM) {
          console.log(`[${new Date().toISOString()}] [DEBUG] Saving DM to Supabase:`, {
            id: processedMessage.id,
            chat_id: processedMessage.chat_id,
            chat_name: processedMessage.chat_name,
            sender_name: processedMessage.sender_name,
            body: processedMessage.body?.substring(0, 50)
          });
        }
        const saveResult = await saveMessage(processedMessage);
        if (isDM) {
          console.log(`[${new Date().toISOString()}] [DEBUG] DM save result: ${saveResult ? 'SUCCESS' : 'FAILED'}`);
        }

        // Determine if webhook should be triggered
        const mentionedJids = getMentionedJids(message);
        const replyToParticipant = getReplyToParticipant(message);
        const botMentioned = isBotMentioned(mentionedJids);
        const replyToBot = isReplyToBot(replyToParticipant);

        // Voice message handling - transcribe and respond (not for channels - viewers can't send voice)
        const isVoiceMessage = processedMessage.message_type === 'audio' && message.message?.audioMessage;

        // Voice processing conditions:
        // 1. DMs: always process (user is talking directly to bot)
        // 2. Groups with @mention or reply: always process (explicit trigger)
        // 3. Groups without explicit trigger: only process for authorized users (admin/brain group)
        //    These will be checked for "Logan" voice trigger after transcription
        const hasExplicitTrigger = botMentioned || replyToBot;
        const isAuthorizedVoiceUser = isGroup && isAuthorizedForVoice(processedMessage.sender_number || '', processedMessage.chat_id);

        const shouldProcessVoice = isVoiceMessage && !isChannel && isVoiceTranscriptionEnabled() &&
          (isDM || hasExplicitTrigger || isAuthorizedVoiceUser);

        if (shouldProcessVoice) {
          console.log(`[${new Date().toISOString()}] [VOICE] Received voice message from ${processedMessage.sender_name || processedMessage.sender_number} in ${processedMessage.chat_name}`);

          try {
            // Download the audio
            const audioBuffer = await downloadMediaMessage(message, 'buffer', {}) as Buffer;

            if (!audioBuffer || audioBuffer.length === 0) {
              console.error(`[${new Date().toISOString()}] [VOICE] Failed to download audio`);
            } else {
              // Transcribe the audio
              const transcriptionResult = await transcribeAudio(audioBuffer);

              if (transcriptionResult.success && transcriptionResult.text) {
                console.log(`[${new Date().toISOString()}] [VOICE] Transcription: "${transcriptionResult.text.substring(0, 50)}${transcriptionResult.text.length > 50 ? '...' : ''}"`);

                // Update the message body with transcription
                const transcribedBody = formatVoiceTranscription(transcriptionResult.text);
                processedMessage.body = transcribedBody;
                processedMessage.message_type = 'voice';

                // Update the saved message with transcription
                await saveMessage(processedMessage);

                // For group voice without explicit trigger, check if "Logan" was said
                // This allows users to trigger the bot by saying "Logan" in their voice message
                const needsLoganTrigger = isGroup && !hasExplicitTrigger;
                const hasLoganTrigger = containsLoganTrigger(transcriptionResult.text);

                if (needsLoganTrigger && !hasLoganTrigger) {
                  console.log(`[${new Date().toISOString()}] [VOICE] No "Logan" trigger in group voice, skipping AI response`);
                  continue; // Skip AI response, but transcription is saved
                }

                // Remove "Logan" from the query if it was a voice trigger
                const actualQuery = hasLoganTrigger
                  ? removeLoganTrigger(transcriptionResult.text)
                  : transcriptionResult.text;

                console.log(`[${new Date().toISOString()}] [VOICE] Processing query: "${actualQuery.substring(0, 50)}${actualQuery.length > 50 ? '...' : ''}"`);

                // Handle AI response for voice message
                if (isMentionResponseEnabled()) {
                  handleVoiceMention(
                    processedMessage.chat_id,
                    processedMessage.chat_name,
                    processedMessage.sender_number || '',
                    processedMessage.sender_name || 'Unknown',
                    actualQuery,
                    false, // isError
                    message.key
                  ).catch(err => {
                    console.error(`[${new Date().toISOString()}] [VOICE] Error in AI voice response:`, err);
                  });
                }
              } else {
                // Transcription failed - only send error if it was an explicit trigger or DM
                console.error(`[${new Date().toISOString()}] [VOICE] Transcription failed: ${transcriptionResult.error}`);

                // Only send error response for explicit triggers (DM, @mention, reply)
                // Don't spam error messages for voice messages that weren't addressed to the bot
                if (isMentionResponseEnabled() && (isDM || hasExplicitTrigger)) {
                  const errorMessage = transcriptionResult.error?.includes('too large')
                    ? 'ההודעה הקולית ארוכה מדי'
                    : 'לא הצלחתי להבין את ההודעה הקולית, אפשר לנסות שוב?';

                  // Send error response (no human simulation for errors)
                  handleVoiceMention(
                    processedMessage.chat_id,
                    processedMessage.chat_name,
                    processedMessage.sender_number || '',
                    processedMessage.sender_name || 'Unknown',
                    `[ERROR] ${errorMessage}`,
                    true, // isError flag
                    message.key
                  ).catch(err => {
                    console.error(`[${new Date().toISOString()}] [VOICE] Error sending error message:`, err);
                  });
                }
              }
            }
          } catch (voiceErr) {
            console.error(`[${new Date().toISOString()}] [VOICE] Error processing voice message:`, voiceErr);
          }

          // Skip normal webhook/AI flow for voice messages (already handled above)
          continue;
        }

        // For DMs: always trigger webhook (every DM is directed at the bot)
        // For groups: trigger on mention, reply, or text trigger (if allowed for sender)
        // For channels: never trigger (no mentions in channels)

        // Check for text-based Logan trigger ("לוגן", "לוגאן", "logan")
        // Admin can use text triggers in ANY group or DM
        // Other users can only use text triggers in FREE_CHAT_GROUPS
        const senderNum = processedMessage.sender_number || '';
        const hasLoganTextTrigger = processedMessage.body && containsLoganTextTrigger(processedMessage.body);
        const isTextTrigger = hasLoganTextTrigger && isTextTriggerAllowed(chatId, senderNum);

        const shouldTriggerWebhook = !isChannel && (isDM || botMentioned || replyToBot || isTextTrigger);

        if (shouldTriggerWebhook) {
          const triggerType = isDM ? 'DM' : (botMentioned ? 'mentioned' : (replyToBot ? 'reply' : 'text-trigger'));
          console.log(`[${new Date().toISOString()}] Bot ${triggerType} ${isDM ? 'from' : 'in'} ${processedMessage.chat_name || 'DM'} by ${processedMessage.sender_name || processedMessage.sender_number}`);

          // Get quoted message text (if this is a reply)
          const quotedMessage = getQuotedMessageText(message) || undefined;

          // Get conversation history for context
          const botNumbers: string[] = [];
          const botJid = getBotJid();
          const botLid = getBotLid();
          if (botJid) botNumbers.push(botJid.split('@')[0].split(':')[0]);
          if (botLid) botNumbers.push(botLid.split('@')[0].split(':')[0]);
          if (process.env.BOT_PHONE_NUMBER) botNumbers.push(process.env.BOT_PHONE_NUMBER);
          if (process.env.BOT_LID) botNumbers.push(process.env.BOT_LID);

          const conversationHistory = await getConversationHistory(
            processedMessage.chat_id,
            botNumbers,
            10 // Last 10 messages
          );

          await sendMentionWebhook({
            groupId: processedMessage.chat_id,
            groupName: processedMessage.chat_name,
            senderNumber: processedMessage.sender_number || '',
            senderName: processedMessage.sender_name || '',
            message: processedMessage.body || '',
            messageId: processedMessage.id,
            timestamp: processedMessage.timestamp,
            quotedMessage,
            conversationHistory: conversationHistory.length > 0 ? conversationHistory : undefined,
          });

          // AI Mention Response (for groups when mentioned/replied/text-triggered, or for all DMs)
          if (isMentionResponseEnabled() && (isDM || (isGroup && (botMentioned || replyToBot || isTextTrigger)))) {
            // Check if message has an image to forward to Logan
            let imageResult: DownloadedImage | null = null;
            if (hasImage(message)) {
              console.log(`[${new Date().toISOString()}] [IMAGE] Downloading image from mention...`);
              imageResult = await downloadImage(message);
              if (imageResult.success) {
                console.log(`[${new Date().toISOString()}] [IMAGE] Image ready: ${imageResult.filePath} (${imageResult.mediaType})`);
              } else {
                console.log(`[${new Date().toISOString()}] [IMAGE] Failed to download: ${imageResult.error}`);
              }
            }

            // For text triggers (לוגן/logan), clean up the trigger word from the message
            let messageToSend = processedMessage.body || '';
            if (isTextTrigger) {
              messageToSend = removeLoganFromText(messageToSend);
              console.log(`[${new Date().toISOString()}] [TEXT-TRIGGER] Cleaned message: "${messageToSend.substring(0, 50)}${messageToSend.length > 50 ? '...' : ''}"`);
            }

            // Handle AI response asynchronously (don't block message processing)
            handleMention(
              processedMessage.chat_id,
              processedMessage.chat_name,
              processedMessage.sender_number || '',
              processedMessage.sender_name || 'Unknown',
              messageToSend,
              message.key,
              imageResult?.filePath,
              imageResult?.mediaType
            ).then(() => {
              // Clean up image file after handler completes (with delay to ensure it's been sent)
              if (imageResult?.filePath) {
                setTimeout(() => {
                  cleanupImage(imageResult!.filePath!);
                }, 60000); // Clean up after 1 minute
              }
            }).catch(err => {
              console.error(`[${new Date().toISOString()}] Error in AI mention response:`, err);
              // Still clean up image on error
              if (imageResult?.filePath) {
                cleanupImage(imageResult.filePath);
              }
            });
          }
        }
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Error processing message:`, err);
      }
    }
  });

  console.log(`[${new Date().toISOString()}] Message handler ready. Listening for messages...`);

  // Separate groups and channels for logging
  const groups = ALLOWED_GROUPS.filter(g => g.id.endsWith('@g.us'));
  const channels = ALLOWED_GROUPS.filter(g => g.id.endsWith('@newsletter'));

  console.log(`[${new Date().toISOString()}] Monitoring ${groups.length} groups:`);
  groups.forEach(g => {
    console.log(`  - ${g.name} (${g.id})`);
  });

  if (channels.length > 0) {
    console.log(`[${new Date().toISOString()}] Monitoring ${channels.length} channels:`);
    channels.forEach(c => {
      console.log(`  - ${c.name} (${c.id})`);
    });
  }

  // Log DM webhook status
  const dmEnabled = process.env.ENABLE_DM_WEBHOOK === 'true';
  console.log(`[${new Date().toISOString()}] DM webhook: ${dmEnabled ? 'ENABLED' : 'DISABLED'}`);

  // Log spam detection status
  console.log(`[${new Date().toISOString()}] Spam detection: ${isSpamDetectionEnabled() ? 'ENABLED' : 'DISABLED'}`);

  // Log join request processing status
  console.log(`[${new Date().toISOString()}] Join request auto-processing: ${isJoinRequestProcessingEnabled() ? 'ENABLED' : 'DISABLED'}`);

  // Log mention webhook configuration
  logMentionWebhookConfig();

  // Log AI mention response configuration
  logMentionResponseConfig();

  // Log voice transcription status
  console.log(`[${new Date().toISOString()}] Voice transcription: ${isVoiceTranscriptionEnabled() ? 'ENABLED (using Groq Whisper)' : 'DISABLED (GROQ_API_KEY not set)'}`);
}
