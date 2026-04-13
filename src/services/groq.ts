import { LOGAN_SYSTEM_PROMPT, LOGAN_FREE_CHAT_PROMPT } from '../prompts/logan';
import { callOpenAIWithMessages, isOpenAIConfigured, getOpenAIModel } from './openai';

// Groq API (Primary)
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL_PRIMARY = 'openai/gpt-oss-120b';
const GROQ_MODEL_FALLBACK = 'openai/gpt-oss-20b';

// Claude API (Fallback)
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';

interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface GroqResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

interface ClaudeResponse {
  content: Array<{
    type: string;
    text: string;
  }>;
}

/**
 * Call Claude API with system prompt
 */
async function callClaudeWithPrompt(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string
): Promise<{ success: boolean; content: string | null; error?: string }> {
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
        messages: [{ role: 'user', content: userPrompt }],
        max_tokens: 800
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, content: null, error: `API error ${response.status}: ${errorText}` };
    }

    const data = await response.json() as ClaudeResponse;

    if (!data.content || data.content.length === 0) {
      return { success: false, content: null, error: 'No content in response' };
    }

    const textContent = data.content.find(c => c.type === 'text');
    if (!textContent?.text) {
      return { success: false, content: null, error: 'No text content in response' };
    }

    // Sanitize response: remove CJK characters that the model might hallucinate
    let content = textContent.text;
    content = content.replace(/[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F\uFF00-\uFFEF]/g, '').trim();

    return { success: true, content };
  } catch (error) {
    return { success: false, content: null, error: String(error) };
  }
}

async function callGroqWithModel(
  apiKey: string,
  messages: GroqMessage[],
  model: string
): Promise<{ success: boolean; content: string | null; error?: string }> {
  try {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 800
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, content: null, error: `API error ${response.status}: ${errorText}` };
    }

    const data = await response.json() as GroqResponse;

    if (!data.choices || data.choices.length === 0) {
      return { success: false, content: null, error: 'No choices in response' };
    }

    // Sanitize response: remove CJK characters that the model might hallucinate
    let content = data.choices[0].message.content;
    // Remove Chinese/Japanese/Korean characters (keep Hebrew, English, numbers, punctuation, emojis)
    content = content.replace(/[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F\uFF00-\uFFEF]/g, '').trim();

    return { success: true, content };
  } catch (error) {
    return { success: false, content: null, error: String(error) };
  }
}

export async function callGroq(userPrompt: string, useFreeChatPrompt: boolean = false): Promise<string | null> {
  const claudeApiKey = process.env.ANTHROPIC_API_KEY;
  const groqApiKey = process.env.GROQ_API_KEY;

  // Check if global free chat mode is enabled
  // Make check robust: trim whitespace, case-insensitive
  const envValue = (process.env.LOGAN_FREE_CHAT_MODE || '').trim().toLowerCase();
  const globalFreeChatMode = envValue === 'true';

  // IMPORTANT: Global free chat mode OVERRIDES everything
  const shouldUseFreeChatPrompt = globalFreeChatMode || useFreeChatPrompt;

  // DEBUG: Always log which prompt is being used
  console.log(`[LOGAN] ========================================`);
  console.log(`[LOGAN] LOGAN_FREE_CHAT_MODE = "${process.env.LOGAN_FREE_CHAT_MODE}" → parsed: "${envValue}"`);
  console.log(`[LOGAN] globalFreeChatMode = ${globalFreeChatMode}, useFreeChatPrompt param = ${useFreeChatPrompt}`);
  console.log(`[LOGAN] FINAL: shouldUseFreeChatPrompt = ${shouldUseFreeChatPrompt}`);

  const systemPrompt = shouldUseFreeChatPrompt ? LOGAN_FREE_CHAT_PROMPT : LOGAN_SYSTEM_PROMPT;

  // Log which prompt is being used with clear indication
  if (shouldUseFreeChatPrompt) {
    const reason = globalFreeChatMode ? 'GLOBAL env override' : 'free chat group';
    console.log(`[LOGAN] ✓✓✓ USING FREE CHAT PROMPT (${reason})`);
  } else {
    console.log(`[LOGAN] ✗✗✗ WARNING: Using RESTRICTED prompt!`);
  }
  console.log(`[LOGAN] ========================================`);

  const messages: GroqMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  // Try OpenAI first if configured (highest quality)
  if (isOpenAIConfigured()) {
    const openAIModel = getOpenAIModel();
    console.log(`[LOGAN] Trying primary: OpenAI (${openAIModel})`);
    const openAIResult = await callOpenAIWithMessages(messages);

    if (openAIResult.success && openAIResult.content) {
      console.log(`[LOGAN] OpenAI succeeded`);
      return openAIResult.content;
    }

    console.log(`[LOGAN] OpenAI failed: ${openAIResult.error}`);
  }

  // Try Groq second (faster and cheaper)
  if (groqApiKey) {
    console.log(`[LOGAN] Trying secondary: Groq (${GROQ_MODEL_PRIMARY})`);
    const primaryResult = await callGroqWithModel(groqApiKey, messages, GROQ_MODEL_PRIMARY);

    if (primaryResult.success && primaryResult.content) {
      console.log(`[LOGAN] Groq primary succeeded`);
      return primaryResult.content;
    }

    console.log(`[LOGAN] Groq primary failed: ${primaryResult.error}`);
    console.log(`[LOGAN] Trying Groq secondary model: ${GROQ_MODEL_FALLBACK}`);

    // Try Groq secondary model
    const secondaryResult = await callGroqWithModel(groqApiKey, messages, GROQ_MODEL_FALLBACK);

    if (secondaryResult.success && secondaryResult.content) {
      console.log(`[LOGAN] Groq secondary succeeded`);
      return secondaryResult.content;
    }

    console.log(`[LOGAN] Groq secondary failed: ${secondaryResult.error}`);
  } else {
    console.log(`[LOGAN] GROQ_API_KEY not configured, skipping Groq`);
  }

  // Fallback to Claude
  if (!claudeApiKey) {
    console.error('[LOGAN] ANTHROPIC_API_KEY not configured, no fallback available');
    return null;
  }

  console.log(`[LOGAN] Trying fallback: Claude (${CLAUDE_MODEL})`);
  const claudeResult = await callClaudeWithPrompt(claudeApiKey, systemPrompt, userPrompt);

  if (claudeResult.success && claudeResult.content) {
    console.log(`[LOGAN] Claude fallback succeeded`);
    return claudeResult.content;
  }

  console.error(`[LOGAN] All models failed. Last error: ${claudeResult.error}`);
  return null;
}

export function buildMentionPrompt(
  groupMessages: Array<{ senderName: string; body: string }>,
  userMessages: Array<{ body: string }>,
  senderName: string,
  currentMessage: string,
  webSearchContext?: string
): string {
  const messageCount = groupMessages.length;
  const groupContext = groupMessages
    .map(m => `${m.senderName}: ${m.body}`)
    .join('\n');

  const userHistory = userMessages
    .map(m => m.body)
    .join('\n');

  // Get current date/time in Jerusalem timezone for accurate responses
  const jerusalemDate = new Date().toLocaleDateString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  const jerusalemTime = new Date().toLocaleTimeString('he-IL', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    minute: '2-digit'
  });

  let prompt = `=== CURRENT DATE & TIME (Jerusalem, Israel) ===
${jerusalemDate}, ${jerusalemTime}

=== CONVERSATION CONTEXT (last ${messageCount} messages) ===
${groupContext}

=== ${senderName}'s recent messages ===
${userHistory}

=== CURRENT QUESTION from ${senderName} ===
${currentMessage}`;

  // Append web search results if available
  if (webSearchContext) {
    prompt += webSearchContext;
  }

  return prompt;
}
