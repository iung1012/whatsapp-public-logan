/**
 * Image Download Utility
 * Downloads images from WhatsApp messages and saves them to temp files
 */

import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { proto } from '@whiskeysockets/baileys';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

type WAMessage = proto.IWebMessageInfo;

// Supported image MIME types
const IMAGE_MIME_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export interface DownloadedImage {
  success: boolean;
  filePath?: string;
  mediaType?: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  error?: string;
}

/**
 * Check if a message contains an image
 */
export function hasImage(message: WAMessage): boolean {
  const msg = message.message;
  if (!msg) return false;

  // Direct image message
  if (msg.imageMessage) return true;

  // View once image
  if (msg.viewOnceMessage?.message?.imageMessage) return true;
  if (msg.viewOnceMessageV2?.message?.imageMessage) return true;

  // Ephemeral image
  if (msg.ephemeralMessage?.message?.imageMessage) return true;

  return false;
}

/**
 * Get image MIME type from message
 */
export function getImageMimeType(message: WAMessage): string | null {
  const msg = message.message;
  if (!msg) return null;

  // Direct image message
  if (msg.imageMessage?.mimetype) {
    return msg.imageMessage.mimetype;
  }

  // View once image
  if (msg.viewOnceMessage?.message?.imageMessage?.mimetype) {
    return msg.viewOnceMessage.message.imageMessage.mimetype;
  }
  if (msg.viewOnceMessageV2?.message?.imageMessage?.mimetype) {
    return msg.viewOnceMessageV2.message.imageMessage.mimetype;
  }

  // Ephemeral image
  if (msg.ephemeralMessage?.message?.imageMessage?.mimetype) {
    return msg.ephemeralMessage.message.imageMessage.mimetype;
  }

  return null;
}

/**
 * Download an image from a WhatsApp message and save to a temp file
 */
export async function downloadImage(message: WAMessage): Promise<DownloadedImage> {
  if (!hasImage(message)) {
    return {
      success: false,
      error: 'Message does not contain an image'
    };
  }

  try {
    // Download the media as a buffer
    const buffer = await downloadMediaMessage(message, 'buffer', {}) as Buffer;

    if (!buffer || buffer.length === 0) {
      return {
        success: false,
        error: 'Failed to download image - empty buffer'
      };
    }

    // Get MIME type and determine file extension
    const mimeType = getImageMimeType(message);
    let extension = 'jpg'; // Default to jpg
    let mediaType: DownloadedImage['mediaType'] = 'image/jpeg';

    if (mimeType && IMAGE_MIME_TYPES[mimeType]) {
      extension = IMAGE_MIME_TYPES[mimeType];
      mediaType = mimeType as DownloadedImage['mediaType'];
    }

    // Create temp directory for WhatsApp images
    const tempDir = path.join(os.tmpdir(), 'whatsapp-images');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Generate unique filename
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const filename = `wa_image_${timestamp}_${randomSuffix}.${extension}`;
    const filePath = path.join(tempDir, filename);

    // Write buffer to file
    fs.writeFileSync(filePath, buffer);

    console.log(`[IMAGE] Downloaded image: ${filePath} (${buffer.length} bytes, ${mediaType})`);

    return {
      success: true,
      filePath,
      mediaType
    };
  } catch (error) {
    console.error('[IMAGE] Error downloading image:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error downloading image'
    };
  }
}

/**
 * Clean up a downloaded image file
 */
export function cleanupImage(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[IMAGE] Cleaned up: ${filePath}`);
    }
  } catch (error) {
    console.error(`[IMAGE] Failed to cleanup ${filePath}:`, error);
  }
}

/**
 * Clean up old image files (older than specified hours)
 */
export function cleanupOldImages(maxAgeHours: number = 24): void {
  const tempDir = path.join(os.tmpdir(), 'whatsapp-images');

  if (!fs.existsSync(tempDir)) {
    return;
  }

  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const now = Date.now();

  try {
    const files = fs.readdirSync(tempDir);
    let cleaned = 0;

    for (const file of files) {
      const filePath = path.join(tempDir, file);
      const stats = fs.statSync(filePath);

      if (now - stats.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[IMAGE] Cleaned up ${cleaned} old image files`);
    }
  } catch (error) {
    console.error('[IMAGE] Error cleaning up old images:', error);
  }
}
