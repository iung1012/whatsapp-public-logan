/**
 * Copilot SDK Agent Service
 *
 * Connects to the Logan Copilot SDK Agent running at localhost:4001
 * for advanced tool usage (Remotion video generation, MCP servers, etc.)
 */

import * as path from 'path';

// Configuration
const COPILOT_AGENT_URL = process.env.COPILOT_AGENT_URL || 'http://localhost:4001';
const COPILOT_AGENT_TIMEOUT = parseInt(process.env.COPILOT_AGENT_TIMEOUT || '120000', 10); // 2 minutes default
const COPILOT_AGENT_LANDING_PAGE_TIMEOUT = parseInt(process.env.COPILOT_AGENT_LANDING_PAGE_TIMEOUT || '720000', 10); // 12 minutes for landing pages (video + Opus 4.5 code gen + build + deploy + verification)

// Path to the Copilot agent's public folder (for video files)
// MUST be configured if using video generation features
const COPILOT_AGENT_PUBLIC_PATH = process.env.COPILOT_AGENT_PUBLIC_PATH || '';

export interface CopilotAgentResponse {
  success: boolean;
  response?: string;
  events?: Array<{
    type: string;
    tool?: string;
    result?: {
      success: boolean;
      stdout?: string;
      stderr?: string;
      filePath?: string;
      videoPath?: string;
      outputPath?: string;
    };
  }>;
  provider?: string;
  model?: string;
  error?: string;
  /** Path to generated media file (video, image, etc.) */
  mediaPath?: string;
}

export interface DirectCommandResponse {
  success: boolean;
  stdout?: string;
  stderr?: string;
  command?: string;
  error?: string;
  exitCode?: number;
}

// Internal types for API responses
interface HealthResponse {
  status: string;
  copilotReady: boolean;
}

interface ExecuteResponse {
  success?: boolean;
  response?: string;
  events?: Array<{
    type: string;
    tool?: string;
    result?: {
      success?: boolean;
      stdout?: string;
      stderr?: string;
      filePath?: string;
      videoPath?: string;
      outputPath?: string;
      output?: string;
      // Video generation specific fields
      videoUrl?: string;
      filename?: string;
      template?: string;
      duration?: number;
      format?: string;
      size?: number;
      // Copilot SDK wrapper fields
      content?: string;
      detailedContent?: string;
    };
  }>;
  provider?: string;
  model?: string;
}

interface ToolsResponse {
  customTools?: Array<{ name: string }>;
  installedMcpServers?: Record<string, unknown>;
}

/**
 * Check if Copilot Agent is available
 */
export async function isCopilotAgentAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${COPILOT_AGENT_URL}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000) // 5 second timeout for health check
    });

    if (!response.ok) return false;

    const data = await response.json() as HealthResponse;
    return data.status === 'ok' && data.copilotReady === true;
  } catch (error) {
    console.log('[COPILOT-AGENT] Health check failed:', error);
    return false;
  }
}

export interface CopilotAgentOptions {
  /** Custom timeout in ms (defaults to COPILOT_AGENT_TIMEOUT) */
  timeout?: number;
  /** Path to an image file to include with the request */
  mediaUrl?: string;
  /** MIME type of the image (e.g., 'image/jpeg', 'image/png') */
  mediaType?: string;
}

/**
 * Call the Copilot SDK Agent with a natural language prompt
 * The agent will interpret the request and use appropriate tools
 * @param prompt - The prompt to send to the agent
 * @param options - Optional configuration including timeout and media attachments
 */
export async function callCopilotAgent(prompt: string, options?: CopilotAgentOptions | number): Promise<CopilotAgentResponse> {
  // Support legacy signature: callCopilotAgent(prompt, timeout)
  const opts: CopilotAgentOptions = typeof options === 'number' ? { timeout: options } : (options || {});
  const timeout = opts.timeout || COPILOT_AGENT_TIMEOUT;

  // Enhanced logging for video requests
  const isVideoRequest = prompt.includes('VIDEO DIRECTOR MODE') || prompt.includes('video');
  if (isVideoRequest) {
    console.log(`[COPILOT-AGENT] ===== VIDEO REQUEST START =====`);
    console.log(`[COPILOT-AGENT] Full prompt being sent to logan-copilot:`);
    console.log(`[COPILOT-AGENT] ---PROMPT START---`);
    console.log(prompt);
    console.log(`[COPILOT-AGENT] ---PROMPT END---`);
    console.log(`[COPILOT-AGENT] Endpoint: ${COPILOT_AGENT_URL}/webhook/execute`);
    console.log(`[COPILOT-AGENT] Timeout: ${timeout / 1000}s`);
  }

  // Log with media info if present
  if (opts.mediaUrl) {
    console.log(`[COPILOT-AGENT] Calling agent with prompt: "${prompt.substring(0, 100)}..." (timeout: ${timeout / 1000}s, media: ${opts.mediaType || 'unknown'})`);
  } else {
    console.log(`[COPILOT-AGENT] Calling agent with prompt: "${prompt.substring(0, 100)}..." (timeout: ${timeout / 1000}s)`);
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // Build request body with optional media fields
    const requestBody: { prompt: string; mediaUrl?: string; mediaType?: string } = { prompt };
    if (opts.mediaUrl) {
      requestBody.mediaUrl = opts.mediaUrl;
    }
    if (opts.mediaType) {
      requestBody.mediaType = opts.mediaType;
    }

    const response = await fetch(`${COPILOT_AGENT_URL}/webhook/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[COPILOT-AGENT] API error ${response.status}: ${errorText}`);
      return {
        success: false,
        error: `Agent API error ${response.status}: ${errorText}`
      };
    }

    const data = await response.json() as ExecuteResponse;
    console.log(`[COPILOT-AGENT] Got response, success: ${data.success}`);
    console.log(`[COPILOT-AGENT] Response text: "${data.response?.substring(0, 100)}..."`);
    console.log(`[COPILOT-AGENT] Events count: ${data.events?.length || 0}`);

    // Enhanced logging for video requests - show full response
    if (isVideoRequest) {
      console.log(`[COPILOT-AGENT] ===== VIDEO RESPONSE DEBUG =====`);
      console.log(`[COPILOT-AGENT] Full response text:`);
      console.log(data.response || '(no response text)');
      console.log(`[COPILOT-AGENT] All events:`);
      console.log(JSON.stringify(data.events, null, 2));
      console.log(`[COPILOT-AGENT] Provider: ${data.provider || 'unknown'}, Model: ${data.model || 'unknown'}`);
    }

    // Extract media path from events if present
    let mediaPath: string | undefined;
    if (data.events && Array.isArray(data.events)) {
      for (const event of data.events) {
        console.log(`[COPILOT-AGENT] Event: type=${event.type}, tool=${event.tool || 'N/A'}`);
        if (event.result) {
          console.log(`[COPILOT-AGENT] Event result keys: ${Object.keys(event.result).join(', ')}`);
          console.log(`[COPILOT-AGENT] Event result: ${JSON.stringify(event.result).substring(0, 200)}`);
        }
        if (event.type === 'tool.execution_complete' && event.result) {
          // The Copilot SDK wraps tool results in { content: string, detailedContent: string }
          // where content is a JSON string containing the actual result
          let parsedResult: Record<string, unknown> = event.result as Record<string, unknown>;

          // Try to parse content if it's a JSON string
          if (event.result.content && typeof event.result.content === 'string') {
            try {
              const parsed = JSON.parse(event.result.content);
              if (typeof parsed === 'object' && parsed !== null) {
                parsedResult = parsed as Record<string, unknown>;
                console.log(`[COPILOT-AGENT] Parsed content JSON: ${JSON.stringify(parsedResult).substring(0, 150)}`);
              }
            } catch (e) {
              // Not JSON, use as-is
            }
          }

          // Check for video generation response (videoUrl is a relative path)
          if (parsedResult.videoUrl && typeof parsedResult.videoUrl === 'string') {
            // Convert relative path like "/videos/video_xxx.mp4" to absolute path
            const relativePath = (parsedResult.videoUrl as string).replace(/^\//, ''); // Remove leading slash
            mediaPath = path.join(COPILOT_AGENT_PUBLIC_PATH, relativePath);
            console.log(`[COPILOT-AGENT] Found video URL: ${parsedResult.videoUrl} → ${mediaPath}`);
            break;
          }

          // Check various other possible output path fields
          const possiblePath = parsedResult.videoPath || parsedResult.filePath ||
                               parsedResult.outputPath || parsedResult.output;
          if (possiblePath && typeof possiblePath === 'string') {
            mediaPath = possiblePath;
            // If path looks relative (starts with /), convert to absolute
            if (mediaPath.startsWith('/') && !mediaPath.startsWith('//')) {
              const relativePath = mediaPath.replace(/^\//, '');
              mediaPath = path.join(COPILOT_AGENT_PUBLIC_PATH, relativePath);
            }
            console.log(`[COPILOT-AGENT] Found media path: ${mediaPath}`);
            break;
          }
        }
      }
    }

    return {
      success: data.success ?? true,
      response: data.response,
      events: data.events as CopilotAgentResponse['events'],
      provider: data.provider,
      model: data.model,
      mediaPath
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.error(`[COPILOT-AGENT] Request timed out after ${timeout}ms`);
      return {
        success: false,
        error: `Request timed out after ${timeout / 1000} seconds`
      };
    }

    console.error('[COPILOT-AGENT] Request failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Get the timeout value for landing page generation requests
 */
export function getLandingPageTimeout(): number {
  return COPILOT_AGENT_LANDING_PAGE_TIMEOUT;
}

/**
 * Execute a direct shell command via the Copilot Agent
 * Bypasses AI interpretation for known commands
 */
export async function executeDirectCommand(
  command: string,
  cwd?: string,
  timeout?: number
): Promise<DirectCommandResponse> {
  console.log(`[COPILOT-AGENT] Executing direct command: "${command}"`);

  try {
    const response = await fetch(`${COPILOT_AGENT_URL}/webhook/direct`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        command,
        cwd,
        timeout: timeout || 30000
      }),
      signal: AbortSignal.timeout(timeout || 30000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Direct command API error ${response.status}: ${errorText}`
      };
    }

    return await response.json() as DirectCommandResponse;
  } catch (error) {
    console.error('[COPILOT-AGENT] Direct command failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Get list of available tools from the Copilot Agent
 */
export async function getAvailableTools(): Promise<{ tools: string[]; mcpServers: string[] } | null> {
  try {
    const response = await fetch(`${COPILOT_AGENT_URL}/tools`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) return null;

    const data = await response.json() as ToolsResponse;
    return {
      tools: data.customTools?.map((t) => t.name) || [],
      mcpServers: Object.keys(data.installedMcpServers || {})
    };
  } catch (error) {
    console.error('[COPILOT-AGENT] Failed to get tools:', error);
    return null;
  }
}

/**
 * Check if Copilot Agent integration is enabled
 */
export function isCopilotAgentEnabled(): boolean {
  return process.env.COPILOT_AGENT_ENABLED === 'true';
}

/**
 * Log configuration on startup
 */
export function logCopilotAgentConfig(): void {
  if (isCopilotAgentEnabled()) {
    console.log(`[COPILOT-AGENT] Integration: ENABLED`);
    console.log(`[COPILOT-AGENT] URL: ${COPILOT_AGENT_URL}`);
    console.log(`[COPILOT-AGENT] Default timeout: ${COPILOT_AGENT_TIMEOUT / 1000}s`);
    console.log(`[COPILOT-AGENT] Landing page timeout: ${COPILOT_AGENT_LANDING_PAGE_TIMEOUT / 1000}s`);

    // Check availability asynchronously
    isCopilotAgentAvailable().then(available => {
      console.log(`[COPILOT-AGENT] Status: ${available ? '✓ Available' : '✗ Not available (will retry on demand)'}`);
    });
  } else {
    console.log(`[COPILOT-AGENT] Integration: DISABLED (set COPILOT_AGENT_ENABLED=true to enable)`);
  }
}
