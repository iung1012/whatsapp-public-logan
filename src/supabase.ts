import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { WhatsAppMessage } from './types';

let supabase: SupabaseClient | null = null;

export function initSupabase(): SupabaseClient {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_KEY environment variables');
  }

  supabase = createClient(supabaseUrl, supabaseKey);
  console.log(`[${new Date().toISOString()}] Supabase client initialized`);
  return supabase;
}

export async function saveMessage(message: WhatsAppMessage): Promise<boolean> {
  if (!supabase) {
    console.error(`[${new Date().toISOString()}] Supabase client not initialized`);
    return false;
  }

  try {
    const { error } = await supabase
      .from('whatsapp_messages')
      .upsert(message, { onConflict: 'id' });

    if (error) {
      console.error(`[${new Date().toISOString()}] Error saving message ${message.id}:`, error.message);
      return false;
    }

    // Distinguish between groups and channels in logging
    const chatPrefix = message.chat_id.endsWith('@newsletter') ? 'Channel' : 'Group';
    console.log(
      `[${new Date().toISOString()}] [MESSAGE] ${chatPrefix}: ${message.chat_name} | ` +
      `${message.sender_name || message.sender_number}: ${message.message_type}` +
      `${message.body ? ` - "${message.body.substring(0, 50)}${message.body.length > 50 ? '...' : ''}"` : ''}`
    );
    return true;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Exception saving message:`, err);
    return false;
  }
}

export function getSupabaseClient(): SupabaseClient | null {
  return supabase;
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  senderName?: string;
  timestamp: number;
}

/**
 * Get recent conversation history between users and the bot in a group
 * @param groupId - The group chat ID
 * @param botNumbers - Array of bot phone numbers/LIDs to identify bot messages
 * @param limit - Maximum number of messages to return (default 10)
 */
export async function getConversationHistory(
  groupId: string,
  botNumbers: string[],
  limit: number = 10
): Promise<ConversationMessage[]> {
  if (!supabase) {
    console.warn('[Supabase] Client not initialized, cannot get conversation history');
    return [];
  }

  try {
    // Get recent messages from this group that have content
    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('sender_number, sender_name, body, timestamp, from_me')
      .eq('chat_id', groupId)
      .eq('is_content', true)
      .not('body', 'is', null)
      .order('timestamp', { ascending: false })
      .limit(limit * 2); // Get more to filter down to relevant ones

    if (error) {
      console.error('[Supabase] Error getting conversation history:', error.message);
      return [];
    }

    if (!data || data.length === 0) {
      return [];
    }

    // Convert to conversation format
    // Messages from bot numbers are 'assistant', others are 'user'
    const history: ConversationMessage[] = data
      .filter(msg => msg.body && msg.body.trim())
      .map(msg => {
        const isBot = msg.from_me || (msg.sender_number && botNumbers.includes(msg.sender_number));
        return {
          role: isBot ? 'assistant' as const : 'user' as const,
          content: msg.body,
          senderName: msg.sender_name || undefined,
          timestamp: msg.timestamp
        };
      })
      .slice(0, limit)
      .reverse(); // Chronological order (oldest first)

    return history;
  } catch (err) {
    console.error('[Supabase] Exception getting conversation history:', err);
    return [];
  }
}

// Like emojis that count as "likes"
const LIKE_EMOJIS = ['👍', '❤️', '🔥', '💯', '👏', '🙌', '💪', '⭐', '🌟', '✨'];

// ============================================
// Pending Responses Persistence
// ============================================

export interface PendingResponse {
  id?: string;
  group_id: string;
  sender_number: string;
  sender_name: string;
  response: string;
  response_type: 'landing_page' | 'video' | 'agent';
  created_at?: string;
  retry_count?: number;
}

/**
 * Save a pending response that couldn't be delivered due to connection issues
 */
export async function savePendingResponse(pendingResponse: Omit<PendingResponse, 'id' | 'created_at'>): Promise<boolean> {
  if (!supabase) {
    console.error('[Supabase] Client not initialized, cannot save pending response');
    return false;
  }

  try {
    const { error } = await supabase
      .from('pending_responses')
      .insert({
        group_id: pendingResponse.group_id,
        sender_number: pendingResponse.sender_number,
        sender_name: pendingResponse.sender_name,
        response: pendingResponse.response,
        response_type: pendingResponse.response_type,
        retry_count: pendingResponse.retry_count || 0
      });

    if (error) {
      console.error('[Supabase] Error saving pending response:', error.message);
      return false;
    }

    console.log(`[Supabase] Saved pending ${pendingResponse.response_type} response for ${pendingResponse.sender_name}`);
    return true;
  } catch (err) {
    console.error('[Supabase] Exception saving pending response:', err);
    return false;
  }
}

/**
 * Get all pending responses that haven't been delivered yet
 */
export async function getPendingResponses(): Promise<PendingResponse[]> {
  if (!supabase) {
    console.warn('[Supabase] Client not initialized, cannot get pending responses');
    return [];
  }

  try {
    const { data, error } = await supabase
      .from('pending_responses')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[Supabase] Error getting pending responses:', error.message);
      return [];
    }

    return (data || []) as PendingResponse[];
  } catch (err) {
    console.error('[Supabase] Exception getting pending responses:', err);
    return [];
  }
}

/**
 * Delete a pending response after it's been successfully delivered
 */
export async function deletePendingResponse(id: string): Promise<boolean> {
  if (!supabase) {
    console.error('[Supabase] Client not initialized, cannot delete pending response');
    return false;
  }

  try {
    const { error } = await supabase
      .from('pending_responses')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('[Supabase] Error deleting pending response:', error.message);
      return false;
    }

    console.log(`[Supabase] Deleted pending response ${id}`);
    return true;
  } catch (err) {
    console.error('[Supabase] Exception deleting pending response:', err);
    return false;
  }
}

/**
 * Increment retry count for a pending response
 */
export async function incrementPendingResponseRetry(id: string): Promise<boolean> {
  if (!supabase) {
    return false;
  }

  try {
    // First get current retry_count
    const { data, error: getError } = await supabase
      .from('pending_responses')
      .select('retry_count')
      .eq('id', id)
      .single();

    if (getError || !data) {
      console.error('[Supabase] Error getting retry count:', getError?.message);
      return false;
    }

    // Then update with incremented value
    const { error: updateError } = await supabase
      .from('pending_responses')
      .update({ retry_count: (data.retry_count || 0) + 1 })
      .eq('id', id);

    if (updateError) {
      console.error('[Supabase] Error incrementing retry count:', updateError.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[Supabase] Exception incrementing retry count:', err);
    return false;
  }
}

interface LikedMessage {
  messageId: string;
  messageKeyJson: string;
  likeCount: number;
  messageBody: string;
}

/**
 * Get recent messages in a group that have received likes/reactions
 * @param groupId - The group chat ID
 * @param limit - Maximum number of messages to check
 */
export async function getMessagesWithLikes(
  groupId: string,
  limit: number = 50
): Promise<LikedMessage[]> {
  if (!supabase) {
    console.warn('[Supabase] Client not initialized, cannot get liked messages');
    return [];
  }

  try {
    // Get reactions (messages of type 'reaction') from this group
    const { data: reactions, error: reactionError } = await supabase
      .from('whatsapp_messages')
      .select('body, reacted_to_id')
      .eq('chat_id', groupId)
      .eq('message_type', 'reaction')
      .not('reacted_to_id', 'is', null)
      .order('timestamp', { ascending: false })
      .limit(200); // Check recent reactions

    if (reactionError || !reactions || reactions.length === 0) {
      return [];
    }

    // Count ALL emoji reactions per message (not just likes)
    const likeCounts = new Map<string, number>();
    for (const reaction of reactions) {
      if (reaction.reacted_to_id && reaction.body) {
        const count = likeCounts.get(reaction.reacted_to_id) || 0;
        likeCounts.set(reaction.reacted_to_id, count + 1);
      }
    }

    if (likeCounts.size === 0) {
      return [];
    }

    // Get the message keys for liked messages
    const likedIds = Array.from(likeCounts.keys());
    const { data: messages, error: msgError } = await supabase
      .from('whatsapp_messages')
      .select('id, message_key_json, body')
      .in('id', likedIds)
      .not('message_key_json', 'is', null);

    if (msgError || !messages) {
      return [];
    }

    // Build result with like counts
    return messages
      .filter(m => m.message_key_json)
      .map(m => ({
        messageId: m.id,
        messageKeyJson: m.message_key_json,
        likeCount: likeCounts.get(m.id) || 0,
        messageBody: m.body || ''
      }))
      .filter(m => m.likeCount > 0)
      .sort((a, b) => b.likeCount - a.likeCount)
      .slice(0, limit);
  } catch (err) {
    console.error('[Supabase] Exception getting liked messages:', err);
    return [];
  }
}
