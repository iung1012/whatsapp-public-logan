import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import * as qrcode from 'qrcode-terminal';
import { AUTH_FOLDER, MAX_RECONNECT_ATTEMPTS } from './config';
import { checkIfCurrentlyShabbat } from './shabbatLocker';
import { useSupabaseAuthState, isSupabaseAuthAvailable } from './services/supabase-auth-state';

let sock: WASocket | null = null;
let reconnectAttempts = 0;
let lastConnectedAt: number | null = null;
let consecutive440Errors = 0;
let connectionState: 'open' | 'close' | 'connecting' = 'connecting';
let stableConnectionTimer: NodeJS.Timeout | null = null;
let isStableConnection = false;
let botJid: string | null = null; // Bot's own JID (phone number format)
let botLid: string | null = null; // Bot's LID (internal WhatsApp ID)
let isReconnecting = false; // Prevent multiple simultaneous reconnection attempts
let currentQrCode: string | null = null; // Current QR code for API access

// Add random jitter to avoid predictable patterns (WhatsApp detects bots)
function addJitter(baseMs: number, jitterPercent: number = 0.3): number {
  const jitter = baseMs * jitterPercent * (Math.random() * 2 - 1); // ±30%
  return Math.round(baseMs + jitter);
}

// Exponential backoff with jitter for 440 errors
function getReconnectDelay(attempt: number, is440: boolean, consecutive440: number): number {
  if (is440) {
    // For 440 errors, use much longer delays - WhatsApp is actively rejecting us
    // Start at 60s, max 10 minutes, with random jitter
    // After 3+ consecutive 440 errors, use even longer delays (2x)
    const baseDelay = consecutive440 >= 3 ? 120000 : 60000; // 120s or 60s base
    const maxDelay = 600000; // 10 minutes max
    const calculatedDelay = Math.min(baseDelay * Math.pow(1.5, attempt - 1), maxDelay);
    return addJitter(calculatedDelay);
  }
  // For other errors, use shorter delays with jitter
  return addJitter(15000); // ~15 seconds with jitter
}

// Clean up existing socket before reconnecting
async function cleanupSocket(): Promise<void> {
  if (sock) {
    try {
      console.log(`[${new Date().toISOString()}] Cleaning up existing socket...`);
      // Remove all event listeners
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('creds.update');
      sock.ev.removeAllListeners('messages.upsert');
      // Try to close gracefully
      sock.end(undefined);
    } catch (err) {
      console.log(`[${new Date().toISOString()}] Socket cleanup error (non-fatal):`, err);
    }
    sock = null;
  }
}

// Handle unhandled promise rejections from Baileys
process.on('unhandledRejection', (reason: any) => {
  // Suppress common Baileys connection errors during reconnection
  if (reason?.message?.includes('Connection Closed') ||
      reason?.output?.statusCode === 428 ||
      reason?.output?.statusCode === 440) {
    console.log(`[${new Date().toISOString()}] Suppressed Baileys error during reconnection`);
    return;
  }
  console.error(`[${new Date().toISOString()}] Unhandled rejection:`, reason);
});

export type MessageHandler = (sock: WASocket) => void;
export type StabilityCallback = () => void | Promise<void>;

let onStabilityCallback: StabilityCallback | null = null;

/**
 * Register a callback to be called when connection becomes stable
 * Used for processing pending responses after reconnection
 */
export function setOnStabilityCallback(callback: StabilityCallback): void {
  onStabilityCallback = callback;
}

export async function connectToWhatsApp(onConnected: MessageHandler): Promise<void> {
  // Clear any pending stability timer
  if (stableConnectionTimer) {
    clearTimeout(stableConnectionTimer);
    stableConnectionTimer = null;
  }
  isStableConnection = false;

  // Clean up any existing socket before creating new one
  await cleanupSocket();

  // Try Supabase auth first (more stable), fall back to file-based
  let state: any;
  let saveCreds: () => Promise<void>;

  const useDbAuth = process.env.USE_SUPABASE_AUTH !== 'false'; // Default to true
  const supabaseAuthAvailable = useDbAuth && await isSupabaseAuthAvailable();

  if (supabaseAuthAvailable) {
    console.log(`[${new Date().toISOString()}] Using Supabase-backed auth state (more stable)`);
    const supabaseAuth = await useSupabaseAuthState();
    if (supabaseAuth) {
      state = supabaseAuth.state;
      saveCreds = supabaseAuth.saveCreds;
    } else {
      // Fall back to file-based
      console.log(`[${new Date().toISOString()}] Supabase auth failed, falling back to file-based`);
      const fileAuth = await useMultiFileAuthState(AUTH_FOLDER);
      state = fileAuth.state;
      saveCreds = fileAuth.saveCreds;
    }
  } else {
    console.log(`[${new Date().toISOString()}] Using file-based auth state`);
    const fileAuth = await useMultiFileAuthState(AUTH_FOLDER);
    state = fileAuth.state;
    saveCreds = fileAuth.saveCreds;
  }

  const { version, isLatest } = await fetchLatestBaileysVersion();

  console.log(`[${new Date().toISOString()}] Using Baileys version ${version.join('.')}, isLatest: ${isLatest}`);

  // For Supabase auth, keys are already cached in DB; for file auth, use memory cache
  const keysStore = supabaseAuthAvailable
    ? state.keys // Supabase keys are already optimized
    : makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }) as any);

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }) as any,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: keysStore,
    },
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
    // STABILITY SETTINGS - Optimized to prevent 440 errors
    syncFullHistory: false,
    markOnlineOnConnect: false, // DISABLED - can cause 440 session conflicts
    fireInitQueries: false, // DISABLED - reduce unnecessary queries that trigger 440
    shouldIgnoreJid: (jid) => jid?.endsWith('@broadcast'),
    // TIMING SETTINGS - Conservative for Cloudflare tunnel stability
    retryRequestDelayMs: 5000, // 5 seconds between retries (was 3s)
    connectTimeoutMs: 120000, // 120 second connection timeout
    keepAliveIntervalMs: 25000, // 25 second keepalive - more frequent to prevent tunnel drops
    qrTimeout: 120000, // 120 second QR timeout
    defaultQueryTimeoutMs: 90000, // 90 second query timeout
    emitOwnEvents: false, // Don't emit events for own messages - reduces traffic
  });

  // Handle connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Display QR code when needed
    if (qr) {
      currentQrCode = qr; // Store for API access
      console.log(`\n[${new Date().toISOString()}] Scan this QR code with WhatsApp:\n`);
      qrcode.generate(qr, { small: true });
      console.log('\n');
    }

    if (connection) {
      connectionState = connection;
    }

    if (connection === 'close') {
      // Clear stability timer on disconnect
      if (stableConnectionTimer) {
        clearTimeout(stableConnectionTimer);
        stableConnectionTimer = null;
      }
      isStableConnection = false;

      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      const is440 = statusCode === 440;

      if (is440) {
        consecutive440Errors++;
      }

      // Calculate how long we were connected
      const connectedDuration = lastConnectedAt ? Math.round((Date.now() - lastConnectedAt) / 1000) : 0;

      console.log(
        `[${new Date().toISOString()}] Connection closed after ${connectedDuration}s. ` +
        `Status: ${statusCode}. Reconnecting: ${shouldReconnect}. 440 errors: ${consecutive440Errors}`
      );

      // Warn about persistent 440 errors
      if (consecutive440Errors >= 3) {
        console.log(
          `[${new Date().toISOString()}] ⚠️ Multiple 440 errors (${consecutive440Errors}). ` +
          `Consider: 1) Close WhatsApp Web in browsers, 2) Wait 5-10 minutes, 3) Delete auth_info and re-scan`
        );
      }

      if (shouldReconnect) {
        reconnectAttempts++;
        if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
          const delay = getReconnectDelay(reconnectAttempts, is440, consecutive440Errors);

          console.log(
            `[${new Date().toISOString()}] Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} ` +
            `in ${Math.round(delay / 1000)}s...`
          );

          // Clean up socket before reconnecting
          await cleanupSocket();

          // Prevent multiple simultaneous reconnection attempts
          if (!isReconnecting) {
            isReconnecting = true;
            setTimeout(async () => {
              isReconnecting = false;
              await connectToWhatsApp(onConnected);
            }, delay);
          } else {
            console.log(`[${new Date().toISOString()}] Reconnection already scheduled, skipping...`);
          }
        } else {
          console.error(
            `[${new Date().toISOString()}] Max reconnection attempts reached. Please restart manually.`
          );
          // Reset attempts after reaching max so manual restart can try again
          reconnectAttempts = 0;
        }
      } else {
        console.log(
          `[${new Date().toISOString()}] Logged out. Delete auth_info folder and restart to re-authenticate.`
        );
      }
    }

    if (connection === 'open') {
      currentQrCode = null; // Clear QR code when connected
      lastConnectedAt = Date.now();
      reconnectAttempts = 0;

      // Capture bot's own JID and LID
      botJid = sock?.user?.id || null;
      botLid = (sock?.user as any)?.lid || null;
      console.log(`[${new Date().toISOString()}] Connected to WhatsApp!`);
      console.log(`[${new Date().toISOString()}] Bot JID: ${botJid}`);
      console.log(`[${new Date().toISOString()}] Bot LID: ${botLid || 'not available'}`);
      console.log(`[${new Date().toISOString()}] Waiting for stability...`);

      // EMERGENCY: Try Shabbat lock ASAP (3s) - don't wait for full 10s stability
      // This is critical because 440 errors can kill connection in 4-5 seconds
      setTimeout(async () => {
        if (connectionState === 'open') {
          console.log(`[${new Date().toISOString()}] Running early Shabbat check (3s)...`);
          try {
            await checkIfCurrentlyShabbat();
          } catch (err) {
            console.error(`[${new Date().toISOString()}] Early Shabbat check error:`, err);
          }
        }
      }, 3000);

      // Don't immediately mark as stable - wait 10 seconds to confirm
      // This prevents false "connected" state during rapid connect/disconnect cycles
      stableConnectionTimer = setTimeout(async () => {
        if (connectionState === 'open') {
          isStableConnection = true;
          consecutive440Errors = 0; // Only reset after stable
          console.log(`[${new Date().toISOString()}] ✓ Connection stable for 10s - ready for messages`);

          // Check if currently Shabbat and lock groups if needed
          await checkIfCurrentlyShabbat();

          // Call stability callback (e.g., process pending responses)
          if (onStabilityCallback) {
            try {
              await onStabilityCallback();
            } catch (err) {
              console.error(`[${new Date().toISOString()}] Stability callback error:`, err);
            }
          }
        }
      }, 10000);

      // Setup message handler immediately (for receiving)
      onConnected(sock!);
    }
  });

  // Save credentials whenever they update
  sock.ev.on('creds.update', saveCreds);
}

export function getSocket(): WASocket | null {
  return sock;
}

export function isConnected(): boolean {
  return connectionState === 'open' && sock !== null;
}

// New function: Check if connection is stable (connected for >10s)
export function isStable(): boolean {
  return isStableConnection && connectionState === 'open' && sock !== null;
}

// Wait for connection to become stable (with timeout)
export async function waitForStability(timeoutMs: number = 15000): Promise<boolean> {
  if (isStable()) {
    return true;
  }

  const startTime = Date.now();

  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      if (isStable()) {
        clearInterval(checkInterval);
        resolve(true);
      } else if (Date.now() - startTime >= timeoutMs) {
        clearInterval(checkInterval);
        resolve(false);
      }
    }, 500); // Check every 500ms
  });
}

// Get the bot's own JID (phone number format)
export function getBotJid(): string | null {
  return botJid;
}

// Get the bot's LID (internal WhatsApp ID)
export function getBotLid(): string | null {
  return botLid;
}

// Get the current QR code (for API access)
export function getCurrentQrCode(): string | null {
  return currentQrCode;
}
