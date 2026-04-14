import { initDb, getDb } from './db';
import { WhatsAppMessage } from './types';

export function initSupabase(): void {
  initDb();
}

export async function saveMessage(message: WhatsAppMessage): Promise<boolean> {
  try {
    const sql = getDb();
    await sql`
      INSERT INTO whatsapp_messages (
        id, chat_id, chat_name, sender_name, sender_number,
        message_type, body, timestamp, from_me, is_group,
        is_content, message_key_json, reacted_to_id
      ) VALUES (
        ${message.id}, ${message.chat_id}, ${message.chat_name},
        ${message.sender_name ?? null}, ${message.sender_number ?? null},
        ${message.message_type}, ${message.body ?? null}, ${message.timestamp},
        ${message.from_me}, ${message.is_group}, ${message.is_content},
        ${message.message_key_json ?? null}, ${message.reacted_to_id ?? null}
      )
      ON CONFLICT (id) DO UPDATE SET
        chat_name        = EXCLUDED.chat_name,
        sender_name      = EXCLUDED.sender_name,
        body             = EXCLUDED.body,
        message_key_json = EXCLUDED.message_key_json,
        reacted_to_id    = EXCLUDED.reacted_to_id
    `;

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

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  senderName?: string;
  timestamp: number;
}

export async function getConversationHistory(
  groupId: string,
  botNumbers: string[],
  limit: number = 10
): Promise<ConversationMessage[]> {
  try {
    const sql = getDb();
    const rows = await sql<{ sender_number: string; sender_name: string; body: string; timestamp: number; from_me: boolean }[]>`
      SELECT sender_number, sender_name, body, timestamp, from_me
      FROM whatsapp_messages
      WHERE chat_id = ${groupId}
        AND is_content = true
        AND body IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ${limit * 2}
    `;

    if (rows.length === 0) return [];

    return rows
      .filter(msg => msg.body && msg.body.trim())
      .map(msg => {
        const isBot = msg.from_me || (msg.sender_number && botNumbers.includes(msg.sender_number));
        return {
          role: isBot ? 'assistant' as const : 'user' as const,
          content: msg.body,
          senderName: msg.sender_name || undefined,
          timestamp: msg.timestamp,
        };
      })
      .slice(0, limit)
      .reverse();
  } catch (err) {
    console.error('[DB] Exception getting conversation history:', err);
    return [];
  }
}

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

export async function savePendingResponse(
  pendingResponse: Omit<PendingResponse, 'id' | 'created_at'>
): Promise<boolean> {
  try {
    const sql = getDb();
    await sql`
      INSERT INTO pending_responses (group_id, sender_number, sender_name, response, response_type, retry_count)
      VALUES (
        ${pendingResponse.group_id}, ${pendingResponse.sender_number},
        ${pendingResponse.sender_name}, ${pendingResponse.response},
        ${pendingResponse.response_type}, ${pendingResponse.retry_count || 0}
      )
    `;
    console.log(`[DB] Saved pending ${pendingResponse.response_type} response for ${pendingResponse.sender_name}`);
    return true;
  } catch (err) {
    console.error('[DB] Exception saving pending response:', err);
    return false;
  }
}

export async function getPendingResponses(): Promise<PendingResponse[]> {
  try {
    const sql = getDb();
    const rows = await sql<PendingResponse[]>`
      SELECT id, group_id, sender_number, sender_name, response, response_type, created_at, retry_count
      FROM pending_responses
      ORDER BY created_at ASC
    `;
    return rows;
  } catch (err) {
    console.error('[DB] Exception getting pending responses:', err);
    return [];
  }
}

export async function deletePendingResponse(id: string): Promise<boolean> {
  try {
    const sql = getDb();
    await sql`DELETE FROM pending_responses WHERE id = ${id}`;
    console.log(`[DB] Deleted pending response ${id}`);
    return true;
  } catch (err) {
    console.error('[DB] Exception deleting pending response:', err);
    return false;
  }
}

export async function incrementPendingResponseRetry(id: string): Promise<boolean> {
  try {
    const sql = getDb();
    await sql`UPDATE pending_responses SET retry_count = retry_count + 1 WHERE id = ${id}`;
    return true;
  } catch (err) {
    console.error('[DB] Exception incrementing retry count:', err);
    return false;
  }
}

interface LikedMessage {
  messageId: string;
  messageKeyJson: string;
  likeCount: number;
  messageBody: string;
}

export async function getMessagesWithLikes(
  groupId: string,
  limit: number = 50
): Promise<LikedMessage[]> {
  try {
    const sql = getDb();

    const reactions = await sql<{ body: string; reacted_to_id: string }[]>`
      SELECT body, reacted_to_id
      FROM whatsapp_messages
      WHERE chat_id = ${groupId}
        AND message_type = 'reaction'
        AND reacted_to_id IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT 200
    `;

    if (reactions.length === 0) return [];

    const likeCounts = new Map<string, number>();
    for (const reaction of reactions) {
      if (reaction.reacted_to_id && reaction.body) {
        likeCounts.set(reaction.reacted_to_id, (likeCounts.get(reaction.reacted_to_id) || 0) + 1);
      }
    }

    if (likeCounts.size === 0) return [];

    const likedIds = Array.from(likeCounts.keys());
    const messages = await sql<{ id: string; message_key_json: string; body: string }[]>`
      SELECT id, message_key_json, body
      FROM whatsapp_messages
      WHERE id = ANY(${likedIds})
        AND message_key_json IS NOT NULL
    `;

    return messages
      .filter(m => m.message_key_json)
      .map(m => ({
        messageId: m.id,
        messageKeyJson: m.message_key_json,
        likeCount: likeCounts.get(m.id) || 0,
        messageBody: m.body || '',
      }))
      .filter(m => m.likeCount > 0)
      .sort((a, b) => b.likeCount - a.likeCount)
      .slice(0, limit);
  } catch (err) {
    console.error('[DB] Exception getting liked messages:', err);
    return [];
  }
}
