/**
 * ElevenLabs Text-to-Speech Service
 * Converts text to natural-sounding speech for voice summaries
 */

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_VOICE_ID = '3JZUpoTOGG7akwuTH0DK'; // Hebrew-friendly voice

interface ElevenLabsVoiceSettings {
  stability: number;
  similarity_boost: number;
}

interface ElevenLabsRequest {
  text: string;
  model_id: string;
  voice_settings: ElevenLabsVoiceSettings;
}

/**
 * Trim text to the last complete sentence to prevent voice cutoff.
 * Looks for Hebrew sentence endings (. ! ?) and trims there.
 */
function trimToCompleteSentence(text: string): string {
  const trimmed = text.trim();

  // If it already ends with sentence-ending punctuation, it's fine
  if (/[.!?]$/.test(trimmed)) {
    return trimmed;
  }

  // Find the last sentence-ending punctuation
  const lastPeriod = trimmed.lastIndexOf('.');
  const lastExcl = trimmed.lastIndexOf('!');
  const lastQuestion = trimmed.lastIndexOf('?');
  const lastEnd = Math.max(lastPeriod, lastExcl, lastQuestion);

  if (lastEnd > trimmed.length * 0.5) {
    // Only trim if we keep at least 50% of the text
    console.log(`[ELEVENLABS] Trimming incomplete sentence: ${trimmed.length} -> ${lastEnd + 1} chars`);
    return trimmed.substring(0, lastEnd + 1);
  }

  // If no good cutoff point, return as-is (better than losing too much)
  console.log(`[ELEVENLABS] No safe sentence boundary found, using full text`);
  return trimmed;
}

/**
 * Convert text to speech using ElevenLabs API
 * @param text The text to convert to speech
 * @returns Audio buffer (mp3 format) or null on failure
 */
export async function textToSpeech(text: string): Promise<Buffer | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;

  if (!apiKey) {
    console.error('[ELEVENLABS] ELEVENLABS_API_KEY not configured');
    return null;
  }

  if (!text || text.trim().length === 0) {
    console.error('[ELEVENLABS] Empty text provided');
    return null;
  }

  // Safety net: trim to last complete sentence
  const safeText = trimToCompleteSentence(text);

  const url = `${ELEVENLABS_API_URL}/${voiceId}`;

  const requestBody: ElevenLabsRequest = {
    text: safeText,
    model_id: 'eleven_v3',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75
    }
  };

  try {
    console.log(`[ELEVENLABS] Converting ${safeText.length} characters to speech...`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ELEVENLABS] API error ${response.status}: ${errorText}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    console.log(`[ELEVENLABS] Generated ${buffer.length} bytes of audio`);
    return buffer;
  } catch (error) {
    console.error('[ELEVENLABS] TTS request failed:', error);
    return null;
  }
}

/**
 * Check if ElevenLabs TTS is enabled (requires API key)
 */
export function isElevenLabsEnabled(): boolean {
  return !!process.env.ELEVENLABS_API_KEY;
}
