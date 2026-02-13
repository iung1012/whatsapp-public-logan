import { DAILY_SUMMARY_PROMPT } from '../prompts/daily-summary';
import { DAILY_SUMMARY_VOICE_PROMPT } from '../prompts/daily-summary-voice';
import { MASTER_SUMMARY_PROMPT, MASTER_SUMMARY_VOICE_PROMPT } from '../prompts/daily-summary-master';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ClaudeResponse {
  content: Array<{
    type: string;
    text: string;
  }>;
}

export async function callClaude(userMessage: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error('[CLAUDE] ANTHROPIC_API_KEY not configured');
    return null;
  }

  const messages: ClaudeMessage[] = [
    { role: 'user', content: userMessage }
  ];

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
        system: DAILY_SUMMARY_PROMPT,
        messages,
        max_tokens: 400
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[CLAUDE] API error ${response.status}: ${errorText}`);
      return null;
    }

    const data = await response.json() as ClaudeResponse;

    if (!data.content || data.content.length === 0) {
      console.error('[CLAUDE] No content in response');
      return null;
    }

    const textContent = data.content.find(c => c.type === 'text');
    return textContent?.text || null;
  } catch (error) {
    console.error('[CLAUDE] Request failed:', error);
    return null;
  }
}

/**
 * Call Claude API for voice-friendly summary (no mentions, emojis, or special characters)
 */
export async function callClaudeForVoice(userMessage: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error('[CLAUDE] ANTHROPIC_API_KEY not configured');
    return null;
  }

  const messages: ClaudeMessage[] = [
    { role: 'user', content: userMessage }
  ];

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
        system: DAILY_SUMMARY_VOICE_PROMPT,
        messages,
        max_tokens: 1024 // Hebrew needs ~3 tokens per char, 1024 gives room for ~350 chars
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[CLAUDE] Voice API error ${response.status}: ${errorText}`);
      return null;
    }

    const data = await response.json() as ClaudeResponse;

    if (!data.content || data.content.length === 0) {
      console.error('[CLAUDE] No content in voice response');
      return null;
    }

    const textContent = data.content.find(c => c.type === 'text');
    return textContent?.text || null;
  } catch (error) {
    console.error('[CLAUDE] Voice request failed:', error);
    return null;
  }
}

/**
 * Check if a number looks like a valid Israeli phone number
 * Valid: 972XXXXXXXXX (12 digits starting with 972)
 * Invalid: LIDs (random internal WhatsApp IDs)
 */
function isValidIsraeliPhone(number: string | null): boolean {
  if (!number) return false;
  // Israeli phone numbers: 972 followed by 9 digits = 12 digits total
  return /^972\d{9}$/.test(number);
}

export function buildDailySummaryPrompt(
  messages: Array<{ senderName: string | null; senderNumber: string | null; body: string | null }>
): string {
  const formattedMessages = messages
    .filter(m => m.body)
    .map(m => {
      const sender = m.senderName || 'Unknown';
      // Only include phone number if it's a valid Israeli number
      // This filters out LIDs (internal WhatsApp IDs) that look like random numbers
      const number = isValidIsraeliPhone(m.senderNumber) ? ` (@${m.senderNumber})` : '';
      return `${sender}${number}: ${m.body}`;
    })
    .join('\n');

  return `הנה ההודעות:\n<discussions>\n${formattedMessages}\n</discussions>`;
}

/**
 * Call Claude API for master channel summary (combined from all groups)
 */
export async function callClaudeForMasterSummary(userMessage: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error('[CLAUDE] ANTHROPIC_API_KEY not configured');
    return null;
  }

  const messages: ClaudeMessage[] = [
    { role: 'user', content: userMessage }
  ];

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
        system: MASTER_SUMMARY_PROMPT,
        messages,
        max_tokens: 400
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[CLAUDE] Master API error ${response.status}: ${errorText}`);
      return null;
    }

    const data = await response.json() as ClaudeResponse;

    if (!data.content || data.content.length === 0) {
      console.error('[CLAUDE] No content in master response');
      return null;
    }

    const textContent = data.content.find(c => c.type === 'text');
    return textContent?.text || null;
  } catch (error) {
    console.error('[CLAUDE] Master request failed:', error);
    return null;
  }
}

/**
 * Call Claude API for master channel voice summary
 */
export async function callClaudeForMasterVoice(userMessage: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error('[CLAUDE] ANTHROPIC_API_KEY not configured');
    return null;
  }

  const messages: ClaudeMessage[] = [
    { role: 'user', content: userMessage }
  ];

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
        system: MASTER_SUMMARY_VOICE_PROMPT,
        messages,
        max_tokens: 1024 // Hebrew needs ~3 tokens per char, 1024 gives room for ~350 chars
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[CLAUDE] Master voice API error ${response.status}: ${errorText}`);
      return null;
    }

    const data = await response.json() as ClaudeResponse;

    if (!data.content || data.content.length === 0) {
      console.error('[CLAUDE] No content in master voice response');
      return null;
    }

    const textContent = data.content.find(c => c.type === 'text');
    return textContent?.text || null;
  } catch (error) {
    console.error('[CLAUDE] Master voice request failed:', error);
    return null;
  }
}

/**
 * Build prompt for master summary with messages from all groups
 */
export function buildMasterSummaryPrompt(
  messagesByGroup: Map<string, Array<{ senderName: string | null; body: string | null }>>,
  totalCount: number
): string {
  let formattedContent = '';

  for (const [groupName, messages] of messagesByGroup) {
    const groupMessages = messages
      .filter(m => m.body)
      .map(m => {
        const sender = m.senderName || 'Unknown';
        return `${sender}: ${m.body}`;
      })
      .join('\n');

    if (groupMessages) {
      formattedContent += `\n[${groupName}]\n${groupMessages}\n`;
    }
  }

  return `הנה ההודעות מכל הקבוצות (${totalCount} הודעות סה"כ):\n<discussions>${formattedContent}</discussions>`;
}
