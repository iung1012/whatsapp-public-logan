/**
 * Media Sender Utility
 *
 * Handles sending various media types (video, image, audio) via WhatsApp
 */

import { getSocket, isConnected, isStable, waitForStability } from '../connection';
import { saveMessage } from '../supabase';
import { ALLOWED_GROUPS } from '../config';
import { WhatsAppMessage } from '../types';
import { markdownToWhatsApp } from './formatting';
import * as fs from 'fs';
import * as path from 'path';

interface SendMediaResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Get MIME type from file extension
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    // Documents
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed',
    '.7z': 'application/x-7z-compressed',
    // Images
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    // Audio
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    // Video
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Send a video to a WhatsApp chat
 *
 * @param chatId - The chat ID (group or DM)
 * @param videoPath - Path to the video file (local path or URL)
 * @param caption - Optional caption for the video
 * @param mentionNumber - Optional phone number to mention
 */
export async function sendVideo(
  chatId: string,
  videoPath: string,
  caption?: string,
  mentionNumber?: string
): Promise<SendMediaResult> {
  console.log(`[MEDIA] Sending video to ${chatId}: ${videoPath}`);

  // Wait for connection stability
  if (!isConnected() || !isStable()) {
    console.log('[MEDIA] Waiting for connection stability...');
    const stable = await waitForStability(15000);
    if (!stable) {
      return { success: false, error: 'WhatsApp not connected' };
    }
  }

  const sock = getSocket();
  if (!sock) {
    return { success: false, error: 'Socket not available' };
  }

  try {
    // Determine if it's a URL or local file
    const isUrl = videoPath.startsWith('http://') || videoPath.startsWith('https://');

    let videoContent: { video: Buffer | { url: string }; caption?: string; mentions?: string[]; gifPlayback?: boolean };

    if (isUrl) {
      videoContent = { video: { url: videoPath } };
    } else {
      // Read local file
      if (!fs.existsSync(videoPath)) {
        return { success: false, error: `Video file not found: ${videoPath}` };
      }

      const videoBuffer = fs.readFileSync(videoPath);
      const fileSizeMB = videoBuffer.length / (1024 * 1024);

      // WhatsApp has a ~64MB limit for media
      if (fileSizeMB > 64) {
        return { success: false, error: `Video too large (${fileSizeMB.toFixed(1)}MB). Max is 64MB.` };
      }

      console.log(`[MEDIA] Video size: ${fileSizeMB.toFixed(2)}MB`);
      videoContent = { video: videoBuffer };
    }

    // Add caption if provided
    if (caption) {
      videoContent.caption = markdownToWhatsApp(caption);
    }

    // Add mention if provided
    if (mentionNumber) {
      const mentionJid = `${mentionNumber}@s.whatsapp.net`;
      videoContent.mentions = [mentionJid];
    }

    // For groups, refresh metadata first
    if (chatId.endsWith('@g.us')) {
      try {
        await sock.groupMetadata(chatId);
      } catch (e) {
        console.log('[MEDIA] Group metadata refresh failed, continuing...');
      }
    }

    // Send the video
    const result = await sock.sendMessage(chatId, videoContent);
    const messageId = result?.key?.id || null;

    console.log(`[MEDIA] Video sent successfully, messageId: ${messageId}`);

    // Log to Supabase
    const isGroup = chatId.endsWith('@g.us');
    const groupConfig = ALLOWED_GROUPS.find(g => g.id === chatId);
    const outgoingMessage: WhatsAppMessage = {
      id: messageId || `video-${Date.now()}`,
      chat_id: chatId,
      chat_name: groupConfig?.name || (isGroup ? 'Unknown Group' : 'DM'),
      sender_name: 'Logan (Bot)',
      sender_number: process.env.BOT_PHONE_NUMBER || null,
      message_type: 'video',
      body: caption || `[Video: ${path.basename(videoPath)}]`,
      timestamp: Math.floor(Date.now() / 1000),
      from_me: true,
      is_group: isGroup,
      is_content: true
    };
    await saveMessage(outgoingMessage);

    return { success: true, messageId: messageId || undefined };
  } catch (error) {
    console.error('[MEDIA] Error sending video:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error sending video'
    };
  }
}

/**
 * Send an image to a WhatsApp chat
 */
export async function sendImage(
  chatId: string,
  imagePath: string,
  caption?: string,
  mentionNumber?: string
): Promise<SendMediaResult> {
  console.log(`[MEDIA] Sending image to ${chatId}: ${imagePath}`);

  if (!isConnected() || !isStable()) {
    const stable = await waitForStability(15000);
    if (!stable) {
      return { success: false, error: 'WhatsApp not connected' };
    }
  }

  const sock = getSocket();
  if (!sock) {
    return { success: false, error: 'Socket not available' };
  }

  try {
    const isUrl = imagePath.startsWith('http://') || imagePath.startsWith('https://');

    let imageContent: { image: Buffer | { url: string }; caption?: string; mentions?: string[] };

    if (isUrl) {
      imageContent = { image: { url: imagePath } };
    } else {
      if (!fs.existsSync(imagePath)) {
        return { success: false, error: `Image file not found: ${imagePath}` };
      }
      const imageBuffer = fs.readFileSync(imagePath);
      imageContent = { image: imageBuffer };
    }

    if (caption) {
      imageContent.caption = markdownToWhatsApp(caption);
    }

    if (mentionNumber) {
      imageContent.mentions = [`${mentionNumber}@s.whatsapp.net`];
    }

    if (chatId.endsWith('@g.us')) {
      try {
        await sock.groupMetadata(chatId);
      } catch (e) {
        // Ignore
      }
    }

    const result = await sock.sendMessage(chatId, imageContent);
    const messageId = result?.key?.id || null;

    // Log to Supabase
    const isGroup = chatId.endsWith('@g.us');
    const groupConfig = ALLOWED_GROUPS.find(g => g.id === chatId);
    await saveMessage({
      id: messageId || `image-${Date.now()}`,
      chat_id: chatId,
      chat_name: groupConfig?.name || (isGroup ? 'Unknown Group' : 'DM'),
      sender_name: 'Logan (Bot)',
      sender_number: process.env.BOT_PHONE_NUMBER || null,
      message_type: 'image',
      body: caption || `[Image: ${path.basename(imagePath)}]`,
      timestamp: Math.floor(Date.now() / 1000),
      from_me: true,
      is_group: isGroup,
      is_content: true
    });

    return { success: true, messageId: messageId || undefined };
  } catch (error) {
    console.error('[MEDIA] Error sending image:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Send a document/file to a WhatsApp chat
 */
export async function sendDocument(
  chatId: string,
  filePath: string,
  fileName?: string,
  caption?: string
): Promise<SendMediaResult> {
  console.log(`[MEDIA] Sending document to ${chatId}: ${filePath}`);

  if (!isConnected() || !isStable()) {
    const stable = await waitForStability(15000);
    if (!stable) {
      return { success: false, error: 'WhatsApp not connected' };
    }
  }

  const sock = getSocket();
  if (!sock) {
    return { success: false, error: 'Socket not available' };
  }

  try {
    const isUrl = filePath.startsWith('http://') || filePath.startsWith('https://');
    const actualFileName = fileName || path.basename(filePath);
    const mimetype = getMimeType(filePath);

    let docContent: { document: Buffer | { url: string }; fileName: string; mimetype: string; caption?: string };

    if (isUrl) {
      docContent = {
        document: { url: filePath },
        fileName: actualFileName,
        mimetype
      };
    } else {
      if (!fs.existsSync(filePath)) {
        return { success: false, error: `File not found: ${filePath}` };
      }
      docContent = {
        document: fs.readFileSync(filePath),
        fileName: actualFileName,
        mimetype
      };
    }

    if (caption) {
      docContent.caption = markdownToWhatsApp(caption);
    }

    if (chatId.endsWith('@g.us')) {
      try {
        await sock.groupMetadata(chatId);
      } catch (e) {
        // Ignore
      }
    }

    const result = await sock.sendMessage(chatId, docContent);
    const messageId = result?.key?.id || null;

    // Log to Supabase
    const isGroup = chatId.endsWith('@g.us');
    const groupConfig = ALLOWED_GROUPS.find(g => g.id === chatId);
    await saveMessage({
      id: messageId || `doc-${Date.now()}`,
      chat_id: chatId,
      chat_name: groupConfig?.name || (isGroup ? 'Unknown Group' : 'DM'),
      sender_name: 'Logan (Bot)',
      sender_number: process.env.BOT_PHONE_NUMBER || null,
      message_type: 'document',
      body: caption || `[Document: ${fileName || path.basename(filePath)}]`,
      timestamp: Math.floor(Date.now() / 1000),
      from_me: true,
      is_group: isGroup,
      is_content: true
    });

    return { success: true, messageId: messageId || undefined };
  } catch (error) {
    console.error('[MEDIA] Error sending document:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Detect media type from file path
 */
export function detectMediaType(filePath: string): 'video' | 'image' | 'audio' | 'document' | 'unknown' {
  const ext = path.extname(filePath).toLowerCase();

  const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.3gp'];
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  const audioExts = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.opus'];

  if (videoExts.includes(ext)) return 'video';
  if (imageExts.includes(ext)) return 'image';
  if (audioExts.includes(ext)) return 'audio';
  if (ext) return 'document';
  return 'unknown';
}

/**
 * Send media file, auto-detecting type
 */
export async function sendMedia(
  chatId: string,
  mediaPath: string,
  caption?: string,
  mentionNumber?: string
): Promise<SendMediaResult> {
  const mediaType = detectMediaType(mediaPath);

  switch (mediaType) {
    case 'video':
      return sendVideo(chatId, mediaPath, caption, mentionNumber);
    case 'image':
      return sendImage(chatId, mediaPath, caption, mentionNumber);
    case 'document':
      return sendDocument(chatId, mediaPath, undefined, caption);
    default:
      return { success: false, error: `Unknown media type for: ${mediaPath}` };
  }
}
