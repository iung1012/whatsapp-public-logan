// OpenAI API Configuration
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4.1';

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

/**
 * Call OpenAI API with messages
 */
async function callOpenAIWithModel(
  apiKey: string,
  messages: OpenAIMessage[],
  model: string = OPENAI_MODEL
): Promise<{ success: boolean; content: string | null; error?: string }> {
  try {
    const response = await fetch(OPENAI_API_URL, {
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

    const data = await response.json() as OpenAIResponse;

    if (!data.choices || data.choices.length === 0) {
      return { success: false, content: null, error: 'No choices in response' };
    }

    let content = data.choices[0].message.content;
    // Remove CJK characters that the model might hallucinate
    content = content.replace(/[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u303F\uFF00-\uFFEF]/g, '').trim();

    return { success: true, content };
  } catch (error) {
    return { success: false, content: null, error: String(error) };
  }
}

/**
 * Check if OpenAI is configured
 */
export function isOpenAIConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Get OpenAI model name
 */
export function getOpenAIModel(): string {
  return process.env.OPENAI_MODEL || OPENAI_MODEL;
}

/**
 * Call OpenAI API with system and user prompts
 */
export async function callOpenAI(
  systemPrompt: string,
  userPrompt: string,
  model?: string
): Promise<{ success: boolean; content: string | null; error?: string }> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return { success: false, content: null, error: 'OPENAI_API_KEY not configured' };
  }

  const messages: OpenAIMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  return callOpenAIWithModel(apiKey, messages, model || getOpenAIModel());
}

/**
 * Call OpenAI with messages array (for conversation context)
 */
export async function callOpenAIWithMessages(
  messages: OpenAIMessage[],
  model?: string
): Promise<{ success: boolean; content: string | null; error?: string }> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return { success: false, content: null, error: 'OPENAI_API_KEY not configured' };
  }

  return callOpenAIWithModel(apiKey, messages, model || getOpenAIModel());
}

export type { OpenAIMessage };