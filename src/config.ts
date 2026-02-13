import { AllowedGroup } from './types';

// Groups and Channels to monitor - configured via ALLOWED_GROUPS env var (JSON array)
// Format: [{"id":"120...@g.us","name":"Group Name"}, ...]
// NOTE: Order matters for Shabbat lock - put priority groups first!
function loadAllowedGroups(): AllowedGroup[] {
  const envGroups = process.env.ALLOWED_GROUPS;
  if (envGroups) {
    try {
      const parsed = JSON.parse(envGroups);
      if (Array.isArray(parsed)) {
        console.log(`[CONFIG] Loaded ${parsed.length} allowed groups from ALLOWED_GROUPS env var`);
        return parsed;
      }
    } catch (error) {
      console.error('[CONFIG] Failed to parse ALLOWED_GROUPS env var:', error);
    }
  }
  // Default: monitor ALL groups if ALLOWED_GROUPS not configured
  console.log('[CONFIG] No ALLOWED_GROUPS configured - will monitor ALL groups');
  return [];
}

export const ALLOWED_GROUPS: AllowedGroup[] = loadAllowedGroups();

// Set of allowed group IDs for fast lookup
// If empty, all groups are allowed
export const ALLOWED_GROUP_IDS = new Set(ALLOWED_GROUPS.map(g => g.id));

// Message types that are considered content (vs system messages)
export const CONTENT_MESSAGE_TYPES = new Set([
  'text',
  'image',
  'video',
  'audio',
  'document',
  'sticker',
  'voice',
  'contact',
  'location',
  'live_location',
  'poll',
  'view_once',
  'edited',
  'button',
  'list',
  'template',
  'interactive',
  'interactive_response',
  'ephemeral',
]);

// Path for storing WhatsApp session credentials
export const AUTH_FOLDER = './auth_info';

// Reconnection settings
export const RECONNECT_INTERVAL_MS = 5000;
export const MAX_RECONNECT_ATTEMPTS = 10;

// Join Request Auto-Processing Settings
export const AUTO_PROCESS_JOIN_REQUESTS = process.env.AUTO_PROCESS_JOIN_REQUESTS === 'true';
export const JOIN_REQUEST_BOT_THRESHOLD = parseInt(process.env.JOIN_REQUEST_BOT_THRESHOLD || '3', 10);
export const MAX_GROUP_SIZE = parseInt(process.env.MAX_GROUP_SIZE || '1024', 10);
export const JOIN_REQUEST_PROCESS_TIME = process.env.JOIN_REQUEST_PROCESS_TIME || '09:00'; // Daily processing time (HH:MM)
