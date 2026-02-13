/**
 * Whisper Transcription Service
 * Uses Groq Whisper API to transcribe audio/voice messages
 */

import { markdownToWhatsApp } from '../utils/formatting';

const GROQ_WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-large-v3';
const MAX_AUDIO_SIZE_BYTES = 25 * 1024 * 1024; // 25MB limit

interface WhisperResponse {
  text: string;
}

interface TranscriptionResult {
  success: boolean;
  text?: string;
  error?: string;
}

/**
 * Transcribe audio buffer using Groq Whisper API
 */
export async function transcribeAudio(audioBuffer: Buffer): Promise<TranscriptionResult> {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    console.error('[WHISPER] GROQ_API_KEY not configured');
    return { success: false, error: 'API key not configured' };
  }

  // Check file size
  if (audioBuffer.length > MAX_AUDIO_SIZE_BYTES) {
    console.warn(`[WHISPER] Audio too large: ${audioBuffer.length} bytes (max ${MAX_AUDIO_SIZE_BYTES})`);
    return { success: false, error: 'Audio file too large (max 25MB)' };
  }

  try {
    // Create form data with the audio file
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
    formData.append('file', blob, 'audio.ogg');
    formData.append('model', WHISPER_MODEL);
    formData.append('language', 'he'); // Hebrew default, Whisper will auto-detect if needed
    formData.append('response_format', 'json');

    console.log(`[WHISPER] Transcribing audio (${audioBuffer.length} bytes)...`);

    const response = await fetch(GROQ_WHISPER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: formData
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[WHISPER] API error ${response.status}: ${errorText}`);
      return { success: false, error: `API error: ${response.status}` };
    }

    const result = await response.json() as WhisperResponse;

    if (!result.text) {
      console.warn('[WHISPER] Empty transcription result');
      return { success: false, error: 'Empty transcription' };
    }

    console.log(`[WHISPER] Transcription successful: "${result.text.substring(0, 50)}${result.text.length > 50 ? '...' : ''}"`);
    return { success: true, text: result.text };
  } catch (error) {
    console.error('[WHISPER] Transcription failed:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Check if voice transcription is enabled (requires GROQ_API_KEY)
 */
export function isVoiceTranscriptionEnabled(): boolean {
  return !!process.env.GROQ_API_KEY;
}

/**
 * Format voice transcription for display
 */
export function formatVoiceTranscription(transcription: string): string {
  return `[🎤 Voice]: ${transcription}`;
}

/**
 * Format response with transcription reference
 * Converts markdown formatting to WhatsApp formatting (** → *, etc.)
 */
export function formatVoiceResponse(response: string, transcription: string): string {
  const formattedResponse = markdownToWhatsApp(response);
  return `${formattedResponse}\n\n---\n🎤 תמלול: "${transcription}"`;
}
