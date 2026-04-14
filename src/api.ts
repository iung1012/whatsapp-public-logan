import express, { Request, Response, NextFunction } from 'express';
import { getSocket, isConnected, isStable, getCurrentQrCode } from './connection';
import { ALLOWED_GROUPS } from './config';
import { saveMessage } from './supabase';
import { WhatsAppMessage } from './types';
import { getShabbatStatus, lockGroups, unlockGroups, isCurrentlyShabbat, areGroupsAlreadyLocked } from './shabbatLocker';
import { runDailySummary, isDailySummaryEnabled, processGroupSummary, isSummaryInProgress, isGroupInCooldown, isAllGroupsSummaryInCooldown } from './features/daily-summary';
import { sendBroadcast } from './features/broadcast';
import { textToSpeech, isElevenLabsEnabled } from './services/elevenlabs';
import { markdownToWhatsApp } from './utils/formatting';
import QRCode from 'qrcode';

const app = express();
app.use(express.json());

// ============================================================================
// MESSAGE QUEUE SYSTEM
// ============================================================================

interface QueuedMessage {
  id: string;
  groupId: string;
  message: string;
  mentionNumber?: string; // Phone number to mention (e.g., "972521234567")
  imageUrl?: string; // URL to image to send with message as caption
  addedAt: number;
  status: 'pending' | 'sending' | 'sent' | 'failed';
  result?: { messageId: string | null; error?: string };
  resolve: (result: { success: boolean; messageId?: string | null; error?: string }) => void;
}

const messageQueue: QueuedMessage[] = [];
let isProcessingQueue = false;
const DELAY_BETWEEN_MESSAGES_MS = 5000; // 5 seconds between messages
const MAX_WAIT_FOR_CONNECTION_MS = 60000; // Wait up to 60 seconds for connection

// Generate unique ID for queue items
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Wait for WhatsApp connection with timeout
async function waitForConnection(maxWaitMs: number = MAX_WAIT_FOR_CONNECTION_MS): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    if (isConnected() && getSocket()) {
      // Prefer stable, but accept connected after 30s
      if (isStable()) return true;
      if (Date.now() - startTime > 30000) return true;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return isConnected() && getSocket() !== null;
}

// Process the message queue
async function processQueue(): Promise<void> {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  console.log(`[${new Date().toISOString()}] Queue processor started (${messageQueue.length} messages)`);

  while (messageQueue.length > 0) {
    const item = messageQueue.find(m => m.status === 'pending');
    if (!item) break;

    item.status = 'sending';
    console.log(`[${new Date().toISOString()}] Processing queued message ${item.id} to ${item.groupId}`);

    // CRITICAL: Block message sending during Shabbat
    if (process.env.SHABBAT_ENABLED === 'true' && (isCurrentlyShabbat() || areGroupsAlreadyLocked())) {
      console.log(`[${new Date().toISOString()}] 🕯️ SHABBAT MODE - Blocking queued message ${item.id}`);
      item.status = 'failed';
      item.result = { messageId: null, error: 'Blocked: Shabbat mode active' };
      item.resolve({ success: false, error: item.result.error });
      const idx = messageQueue.indexOf(item);
      if (idx > -1) messageQueue.splice(idx, 1);
      continue;
    }

    // Wait for connection if not connected
    if (!isConnected()) {
      console.log(`[${new Date().toISOString()}] Waiting for connection before sending...`);
      const connected = await waitForConnection();
      if (!connected) {
        item.status = 'failed';
        item.result = { messageId: null, error: 'WhatsApp not connected after 60s wait' };
        item.resolve({ success: false, error: item.result.error });

        // Remove from queue
        const idx = messageQueue.indexOf(item);
        if (idx > -1) messageQueue.splice(idx, 1);
        continue;
      }
    }

    try {
      const sock = getSocket();
      if (!sock) {
        throw new Error('Socket not available');
      }

      let result;
      let messageType = 'text';

      if (item.imageUrl) {
        // Send image message with caption
        console.log(`[${new Date().toISOString()}] Sending image message to ${item.groupId}`);
        // Convert markdown formatting to WhatsApp formatting (** → *, etc.)
        const formattedCaption = item.message ? markdownToWhatsApp(item.message) : undefined;
        const imageContent: { image: { url: string }; caption?: string; mentions?: string[] } = {
          image: { url: item.imageUrl },
          caption: formattedCaption
        };

        if (item.mentionNumber) {
          const mentionJid = `${item.mentionNumber}@s.whatsapp.net`;
          imageContent.mentions = [mentionJid];
        }

        result = await sock.sendMessage(item.groupId, imageContent);
        messageType = 'image';
      } else {
        // Send regular text message
        // Convert markdown formatting to WhatsApp formatting (** → *, etc.)
        const formattedMessage = markdownToWhatsApp(item.message);
        const messageContent: { text: string; mentions?: string[] } = { text: formattedMessage };

        if (item.mentionNumber) {
          // Add mention JID (format: number@s.whatsapp.net)
          const mentionJid = `${item.mentionNumber}@s.whatsapp.net`;
          messageContent.mentions = [mentionJid];
        }

        result = await sock.sendMessage(item.groupId, messageContent);
      }

      item.status = 'sent';
      item.result = { messageId: result?.key?.id || null };
      item.resolve({ success: true, messageId: item.result.messageId });

      console.log(`[${new Date().toISOString()}] ✓ Sent ${messageType} message ${item.id}, messageId: ${item.result.messageId}`);

      // Log bot's outgoing message to Supabase
      const isGroup = item.groupId.endsWith('@g.us');
      const groupConfig = ALLOWED_GROUPS.find(g => g.id === item.groupId);
      const outgoingMessage: WhatsAppMessage = {
        id: result?.key?.id || item.id,
        chat_id: item.groupId,
        chat_name: groupConfig?.name || (isGroup ? 'Unknown Group' : 'DM'),
        sender_name: 'Logan (Bot)',
        sender_number: process.env.BOT_PHONE_NUMBER || null,
        message_type: messageType,
        body: item.imageUrl ? `${item.message || ''}\n[image: ${item.imageUrl}]` : item.message,
        timestamp: Math.floor(Date.now() / 1000),
        from_me: true,
        is_group: isGroup,
        is_content: true
      };
      await saveMessage(outgoingMessage);
    } catch (error) {
      item.status = 'failed';
      item.result = { messageId: null, error: error instanceof Error ? error.message : 'Unknown error' };
      item.resolve({ success: false, error: item.result.error });

      console.error(`[${new Date().toISOString()}] ✗ Failed to send ${item.id}: ${item.result.error}`);
    }

    // Remove processed item from queue
    const idx = messageQueue.indexOf(item);
    if (idx > -1) messageQueue.splice(idx, 1);

    // Wait before processing next message
    if (messageQueue.some(m => m.status === 'pending')) {
      console.log(`[${new Date().toISOString()}] Waiting ${DELAY_BETWEEN_MESSAGES_MS / 1000}s before next message...`);
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_MESSAGES_MS));
    }
  }

  isProcessingQueue = false;
  console.log(`[${new Date().toISOString()}] Queue processor finished`);
}

// Add message to queue and return a promise that resolves when sent
function queueMessage(groupId: string, message: string, mentionNumber?: string, imageUrl?: string): Promise<{ success: boolean; messageId?: string | null; error?: string }> {
  return new Promise((resolve) => {
    const item: QueuedMessage = {
      id: generateId(),
      groupId,
      message,
      mentionNumber,
      imageUrl,
      addedAt: Date.now(),
      status: 'pending',
      resolve
    };

    messageQueue.push(item);
    const msgType = imageUrl ? 'image' : 'text';
    console.log(`[${new Date().toISOString()}] Queued ${msgType} message ${item.id} to ${groupId} (queue size: ${messageQueue.length})`);

    // Start processing if not already running
    if (!isProcessingQueue) {
      processQueue();
    }
  });
}

// ============================================================================
// EXPRESS MIDDLEWARE
// ============================================================================

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path} - ${req.ip}`);
  next();
});

// Optional API key authentication middleware
function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = process.env.API_KEY;

  // Skip authentication if API_KEY is not set (local development)
  if (!apiKey) {
    next();
    return;
  }

  const providedKey = req.headers['x-api-key'];

  if (!providedKey || providedKey !== apiKey) {
    res.status(401).json({ success: false, error: 'Unauthorized: Invalid or missing API key' });
    return;
  }

  next();
}

// Apply API key auth to all /api routes
app.use('/api', apiKeyAuth);

// ============================================================================
// API ENDPOINTS
// ============================================================================

// Health check endpoint with detailed status
app.get('/api/health', (_req: Request, res: Response) => {
  const connected = isConnected();
  const stable = isStable();
  const queueSize = messageQueue.length;
  const processing = isProcessingQueue;

  res.json({
    status: 'ok',
    whatsapp: stable ? 'stable' : (connected ? 'connected' : 'disconnected'),
    queue: {
      size: queueSize,
      processing: processing
    }
  });
});

// Get QR code for WhatsApp authentication
// Returns QR code as PNG image or JSON with status
app.get('/api/qr', async (req: Request, res: Response) => {
  const qrData = getCurrentQrCode();
  const format = req.query.format as string || 'image'; // 'image' or 'json'
  const connected = isConnected();
  const stable = isStable();

  console.log(`[API] QR endpoint called - connected: ${connected}, stable: ${stable}, hasQR: ${!!qrData}`);

  if (!qrData) {
    if (connected) {
      return res.status(200).json({ 
        status: 'connected',
        message: 'WhatsApp is already connected. No QR code needed.',
        whatsapp: { connected, stable }
      });
    }
    return res.status(503).json({ 
      status: 'unavailable',
      message: 'QR code not available yet. Please wait for connection initialization or check logs.',
      whatsapp: { connected, stable }
    });
  }

  if (format === 'json') {
    return res.json({ 
      status: 'available',
      qr: qrData,
      whatsapp: { connected, stable }
    });
  }

  // Return as PNG image
  try {
    const qrImage = await QRCode.toBuffer(qrData, { 
      type: 'png',
      width: 400,
      margin: 2
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(qrImage);
  } catch (error) {
    console.error('[API] Error generating QR code image:', error);
    res.status(500).json({ error: 'Failed to generate QR code image', details: String(error) });
  }
});

// QR code viewer page (HTML)
app.get('/qr', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>WhatsApp QR Code - Logan Bot</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .container {
      text-align: center;
      background: rgba(255, 255, 255, 0.1);
      padding: 2rem;
      border-radius: 20px;
      backdrop-filter: blur(10px);
      box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
    }
    h1 { margin: 0 0 1rem 0; font-size: 2rem; }
    #qr-container {
      background: white;
      padding: 1rem;
      border-radius: 10px;
      margin: 1rem 0;
      min-height: 400px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #qr-image { max-width: 100%; height: auto; }
    #status {
      margin-top: 1rem;
      padding: 0.5rem 1rem;
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.2);
    }
    .loading {
      border: 4px solid rgba(255, 255, 255, 0.3);
      border-top: 4px solid white;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .error { color: #ff6b6b; }
    .success { color: #51cf66; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🤖 Logan WhatsApp Bot</h1>
    <p>Scan the QR code with WhatsApp to connect</p>
    <div id="qr-container">
      <div class="loading"></div>
    </div>
    <div id="status">Loading...</div>
  </div>
  <script>
    async function loadQR() {
      try {
        const response = await fetch('/api/qr?format=json');
        const data = await response.json();
        
        if (data.status === 'available') {
          document.getElementById('qr-container').innerHTML = 
            '<img id="qr-image" src="/api/qr" alt="QR Code">';
          document.getElementById('status').innerHTML = 
            '<span class="success">✓ QR Code ready - Scan with WhatsApp</span>';
        } else if (data.status === 'connected') {
          document.getElementById('qr-container').innerHTML = 
            '<div style="color: #51cf66; font-size: 3rem;">✓</div>';
          document.getElementById('status').innerHTML = 
            '<span class="success">✓ Already connected to WhatsApp</span>';
        } else {
          document.getElementById('qr-container').innerHTML = 
            '<div style="color: #666;">⏳</div>';
          document.getElementById('status').innerHTML = 
            '<span>⏳ Waiting for QR code... Refreshing in 3s</span>';
          setTimeout(loadQR, 3000);
        }
      } catch (error) {
        document.getElementById('qr-container').innerHTML = 
          '<div style="color: #ff6b6b;">✗</div>';
        document.getElementById('status').innerHTML = 
          '<span class="error">✗ Error: ' + error.message + '</span>';
        setTimeout(loadQR, 5000);
      }
    }
    loadQR();
  </script>
</body>
</html>
  `);
});

// Send message to specific group (queued)
// Supports both text and image messages
// Optional: mentionNumber to tag a user in the response (e.g., "972521234567")
// Optional: imageUrl to send an image with text as caption
app.post('/api/send-message', async (req: Request, res: Response) => {
  try {
    const { groupId, message, text, mentionNumber, imageUrl } = req.body;

    // Support both 'message' and 'text' fields for flexibility
    const messageText = message || text || '';

    // Validate required fields
    // For text messages: groupId and message/text required
    // For image messages: groupId and imageUrl required (text is optional caption)
    if (!groupId) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: groupId is required'
      });
      return;
    }

    if (!imageUrl && !messageText) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: message/text is required (or imageUrl for image messages)'
      });
      return;
    }

    // CRITICAL: Block messages during Shabbat
    if (process.env.SHABBAT_ENABLED === 'true' && (isCurrentlyShabbat() || areGroupsAlreadyLocked())) {
      console.log(`[${new Date().toISOString()}] 🕯️ SHABBAT MODE - Blocking send-message API call to ${groupId}`);
      res.status(403).json({
        success: false,
        error: 'Blocked: Shabbat mode active - no messages allowed'
      });
      return;
    }

    // Queue the message and wait for result
    const result = await queueMessage(groupId, messageText, mentionNumber, imageUrl);

    if (result.success) {
      res.json({
        success: true,
        messageId: result.messageId
      });
    } else {
      res.status(503).json({
        success: false,
        error: result.error || 'Failed to send message'
      });
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error in send-message:`, error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    });
  }
});

// Send message to all monitored groups (queued)
// Supports TTS: { "message": "text", "tts": true, "language": "he" }
app.post('/api/send-to-all-groups', async (req: Request, res: Response) => {
  try {
    const { message, tts, language } = req.body;

    // Validate required fields
    if (!message) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: message is required'
      });
      return;
    }

    // CRITICAL: Block all group messages during Shabbat
    if (process.env.SHABBAT_ENABLED === 'true' && (isCurrentlyShabbat() || areGroupsAlreadyLocked())) {
      console.log(`[${new Date().toISOString()}] 🕯️ SHABBAT MODE - Blocking send-to-all-groups API call`);
      res.status(403).json({
        success: false,
        error: 'Blocked: Shabbat mode active - no messages allowed'
      });
      return;
    }

    // Check connection
    const sock = getSocket();
    if (!sock || !isStable()) {
      res.status(503).json({
        success: false,
        error: 'WhatsApp not connected'
      });
      return;
    }

    // If TTS requested, generate audio and send as voice notes
    if (tts === true) {
      console.log(`[${new Date().toISOString()}] [TTS] Generating TTS for message (${message.length} chars, language: ${language || 'default'})`);

      if (!isElevenLabsEnabled()) {
        res.status(400).json({
          success: false,
          error: 'TTS not available - ELEVENLABS_API_KEY not configured'
        });
        return;
      }

      const audioBuffer = await textToSpeech(message);
      if (!audioBuffer) {
        res.status(500).json({
          success: false,
          error: 'Failed to generate TTS audio'
        });
        return;
      }

      console.log(`[${new Date().toISOString()}] [TTS] Generated ${audioBuffer.length} bytes of audio, sending to ${ALLOWED_GROUPS.length} groups`);

      // Send voice note to all groups
      const results: { groupId: string; groupName: string; messageId: string | null; error?: string }[] = [];

      for (const group of ALLOWED_GROUPS) {
        try {
          console.log(`[${new Date().toISOString()}] [TTS] Sending voice note to ${group.name}...`);
          const result = await sock.sendMessage(group.id, {
            audio: audioBuffer,
            mimetype: 'audio/mpeg',
            ptt: true // Push-to-talk (voice note)
          });

          results.push({
            groupId: group.id,
            groupName: group.name,
            messageId: result?.key?.id || null
          });
          console.log(`[${new Date().toISOString()}] [TTS] ✓ Sent to ${group.name}`);

          // Log to Supabase
          const outgoingMessage: WhatsAppMessage = {
            id: result?.key?.id || `tts-${Date.now()}`,
            chat_id: group.id,
            chat_name: group.name,
            sender_name: 'Logan (Bot)',
            sender_number: process.env.BOT_PHONE_NUMBER || null,
            message_type: 'audio',
            body: `[TTS Voice Note] ${message}`,
            timestamp: Math.floor(Date.now() / 1000),
            from_me: true,
            is_group: true,
            is_content: true
          };
          await saveMessage(outgoingMessage);

          // Wait between groups to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 3000));
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          console.error(`[${new Date().toISOString()}] [TTS] ✗ Failed to send to ${group.name}:`, errorMsg);
          results.push({
            groupId: group.id,
            groupName: group.name,
            messageId: null,
            error: errorMsg
          });
        }
      }

      const allSucceeded = results.every(r => !r.error);
      res.json({
        success: allSucceeded,
        tts: true,
        sent: results
      });
      return;
    }

    // Regular text message - queue for all groups
    const promises = ALLOWED_GROUPS.map(group =>
      queueMessage(group.id, message).then(result => ({
        groupId: group.id,
        groupName: group.name,
        messageId: result.messageId || null,
        error: result.error
      }))
    );

    // Wait for all messages to be sent
    const results = await Promise.all(promises);
    const allSucceeded = results.every(r => !r.error);

    res.json({
      success: allSucceeded,
      sent: results
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error in send-to-all-groups:`, error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    });
  }
});

// Get queue status
app.get('/api/queue', (_req: Request, res: Response) => {
  res.json({
    size: messageQueue.length,
    processing: isProcessingQueue,
    messages: messageQueue.map(m => ({
      id: m.id,
      groupId: m.groupId,
      status: m.status,
      addedAt: new Date(m.addedAt).toISOString()
    }))
  });
});

// Get Shabbat/Holiday locker status
app.get('/api/shabbat', (_req: Request, res: Response) => {
  const status = getShabbatStatus();
  res.json({
    enabled: status.enabled,
    scheduledLock: status.scheduledLock,
    scheduledUnlock: status.scheduledUnlock,
    candleLighting: status.candleLighting,
    havdalah: status.havdalah,
    groups: ALLOWED_GROUPS.map(g => ({ id: g.id, name: g.name }))
  });
});

// Test group lock/unlock permissions
// Locks the group, waits 5 seconds, then unlocks
app.get('/api/test-lock/:groupId', async (req: Request, res: Response) => {
  const groupId = req.params.groupId as string;

  console.log(`[${new Date().toISOString()}] [TestLock] Testing lock permissions for ${groupId}`);

  const sock = getSocket();
  if (!sock || !isStable()) {
    res.status(503).json({
      success: false,
      error: 'WhatsApp not connected'
    });
    return;
  }

  let lockResult = 'ok';
  let unlockResult = 'ok';

  try {
    // Step 1: Lock the group (announcement mode)
    console.log(`[${new Date().toISOString()}] [TestLock] Locking group...`);
    await sock.groupSettingUpdate(groupId, 'announcement');
    console.log(`[${new Date().toISOString()}] [TestLock] Lock successful`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${new Date().toISOString()}] [TestLock] Lock failed:`, errorMsg);

    // Check if it's a permissions error
    if (errorMsg.includes('admin') || errorMsg.includes('403') || errorMsg.includes('not-authorized')) {
      res.status(403).json({
        success: false,
        error: 'Bot is not admin in this group'
      });
      return;
    }

    lockResult = errorMsg;
  }

  // Step 2: Wait 5 seconds
  if (lockResult === 'ok') {
    console.log(`[${new Date().toISOString()}] [TestLock] Waiting 5 seconds...`);
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Step 3: Unlock the group
    try {
      console.log(`[${new Date().toISOString()}] [TestLock] Unlocking group...`);
      await sock.groupSettingUpdate(groupId, 'not_announcement');
      console.log(`[${new Date().toISOString()}] [TestLock] Unlock successful`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[${new Date().toISOString()}] [TestLock] Unlock failed:`, errorMsg);
      unlockResult = errorMsg;
    }
  }

  const success = lockResult === 'ok' && unlockResult === 'ok';

  res.json({
    success,
    groupId,
    lockResult,
    unlockResult
  });
});

// Lock a group (announcement mode - admins only can post)
// POST body: { "groupId": "YOUR_GROUP_ID@g.us" }
app.post('/api/group-lock', async (req: Request, res: Response) => {
  const { groupId } = req.body;

  if (!groupId) {
    res.status(400).json({ success: false, error: 'groupId is required' });
    return;
  }

  console.log(`[${new Date().toISOString()}] [Lock] Locking group ${groupId}`);

  const sock = getSocket();
  if (!sock || !isStable()) {
    res.status(503).json({ success: false, error: 'WhatsApp not connected' });
    return;
  }

  try {
    await sock.groupSettingUpdate(groupId, 'announcement');
    console.log(`[${new Date().toISOString()}] [Lock] ✓ Locked ${groupId}`);
    res.json({ success: true, groupId, locked: true });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${new Date().toISOString()}] [Lock] ✗ Failed:`, errorMsg);
    res.status(500).json({ success: false, error: errorMsg });
  }
});

// Unlock a group (everyone can post)
// POST body: { "groupId": "YOUR_GROUP_ID@g.us" }
app.post('/api/group-unlock', async (req: Request, res: Response) => {
  const { groupId } = req.body;

  if (!groupId) {
    res.status(400).json({ success: false, error: 'groupId is required' });
    return;
  }

  console.log(`[${new Date().toISOString()}] [Unlock] Unlocking group ${groupId}`);

  const sock = getSocket();
  if (!sock || !isStable()) {
    res.status(503).json({ success: false, error: 'WhatsApp not connected' });
    return;
  }

  try {
    await sock.groupSettingUpdate(groupId, 'not_announcement');
    console.log(`[${new Date().toISOString()}] [Unlock] ✓ Unlocked ${groupId}`);
    res.json({ success: true, groupId, locked: false });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${new Date().toISOString()}] [Unlock] ✗ Failed:`, errorMsg);
    res.status(500).json({ success: false, error: errorMsg });
  }
});

// Test Shabbat lock - locks all monitored groups with Shabbat message
app.get('/api/test-shabbat-lock', async (_req: Request, res: Response) => {
  console.log(`[${new Date().toISOString()}] [TestShabbatLock] Manual trigger requested`);

  if (!isConnected() || !isStable()) {
    res.status(503).json({
      success: false,
      error: 'WhatsApp not connected'
    });
    return;
  }

  // Run async and return immediately
  res.json({
    success: true,
    message: 'Shabbat lock started. Check logs for progress.'
  });

  // Run the lock process in the background
  lockGroups().catch(err => {
    console.error(`[${new Date().toISOString()}] [TestShabbatLock] Error:`, err);
  });
});

// Test Shabbat unlock - unlocks all monitored groups with welcome back message
app.get('/api/test-shabbat-unlock', async (_req: Request, res: Response) => {
  console.log(`[${new Date().toISOString()}] [TestShabbatUnlock] Manual trigger requested`);

  if (!isConnected() || !isStable()) {
    res.status(503).json({
      success: false,
      error: 'WhatsApp not connected'
    });
    return;
  }

  // Run async and return immediately
  res.json({
    success: true,
    message: 'Shabbat unlock started. Check logs for progress.'
  });

  // Run the unlock process in the background
  unlockGroups().catch(err => {
    console.error(`[${new Date().toISOString()}] [TestShabbatUnlock] Error:`, err);
  });
});

// Test daily summary - runs immediately for all groups
// Use ?force=true to bypass Shabbat check
app.get('/api/test-daily-summary', async (req: Request, res: Response) => {
  const forceRun = req.query.force === 'true';
  console.log(`[${new Date().toISOString()}] [TestDailySummary] Manual trigger requested (force=${forceRun})`);

  if (!isDailySummaryEnabled()) {
    res.status(400).json({
      success: false,
      error: 'Daily summary is not enabled. Set DAILY_SUMMARY_ENABLED=true and ANTHROPIC_API_KEY'
    });
    return;
  }

  if (!isConnected() || !isStable()) {
    res.status(503).json({
      success: false,
      error: 'WhatsApp not connected'
    });
    return;
  }

  // Run async and return immediately
  res.json({
    success: true,
    message: `Daily summary started${forceRun ? ' (force mode)' : ''}. Check logs for progress.`
  });

  // Run the summary process in the background
  runDailySummary(false, forceRun).catch(err => {
    console.error(`[${new Date().toISOString()}] [TestDailySummary] Error:`, err);
  });
});

// Trigger summary for a specific group
// GET /api/summary/:groupId
app.get('/api/summary/:groupId', async (req: Request, res: Response) => {
  const groupId = req.params.groupId as string;
  console.log(`[${new Date().toISOString()}] [Summary] Manual trigger for group: ${groupId}`);

  // Find group in allowed groups
  const group = ALLOWED_GROUPS.find(g => g.id === groupId);
  if (!group) {
    res.status(404).json({
      success: false,
      error: `Group ${groupId} not found in ALLOWED_GROUPS`
    });
    return;
  }

  if (!isDailySummaryEnabled()) {
    res.status(400).json({
      success: false,
      error: 'Daily summary is not enabled. Set DAILY_SUMMARY_ENABLED=true and ANTHROPIC_API_KEY'
    });
    return;
  }

  if (!isConnected() || !isStable()) {
    res.status(503).json({
      success: false,
      error: 'WhatsApp not connected'
    });
    return;
  }

  // Check cooldown FIRST (persistent, survives restarts/crashes)
  const cooldown = isGroupInCooldown(groupId);
  if (cooldown.inCooldown) {
    const remainingMinutes = Math.ceil(cooldown.remainingMs / 60000);
    res.status(429).json({
      success: false,
      error: `Summary for ${group.name} is in cooldown. Last sent: ${cooldown.lastSentAt?.toISOString()}. Try again in ${remainingMinutes} minutes.`,
      cooldown: {
        lastSentAt: cooldown.lastSentAt?.toISOString(),
        remainingMinutes
      }
    });
    return;
  }

  // Check if summary is already in progress for this group (in-memory)
  if (isSummaryInProgress(groupId)) {
    res.status(409).json({
      success: false,
      error: `Summary already in progress for ${group.name}. Please wait for it to complete.`
    });
    return;
  }

  // Run async and return immediately
  res.json({
    success: true,
    message: `Summary started for ${group.name}. Check logs for progress.`
  });

  // Run the summary process in the background
  processGroupSummary(groupId, group.name).catch(err => {
    console.error(`[${new Date().toISOString()}] [Summary] Error for ${group.name}:`, err);
  });
});

// Broadcast message to all monitored groups
// POST body: { "text": "Message text", "imageUrl": "https://..." (optional) }
app.post('/api/broadcast', async (req: Request, res: Response) => {
  try {
    const { text, imageUrl } = req.body;

    // Validate required fields
    if (!text && !imageUrl) {
      res.status(400).json({
        success: false,
        error: 'Missing required field: text or imageUrl is required'
      });
      return;
    }

    // Check WhatsApp connection
    if (!isConnected() || !isStable()) {
      res.status(503).json({
        success: false,
        error: 'WhatsApp not connected'
      });
      return;
    }

    // Send broadcast (runs in background, returns immediately after starting)
    const result = await sendBroadcast(text || '', imageUrl);

    res.json({
      success: result.success,
      sentTo: result.sentTo,
      results: result.results
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error in broadcast:`, error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    });
  }
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

export function startApiServer(): void {
  const port = parseInt(process.env.API_PORT || '7700', 10);

  app.listen(port, () => {
    console.log(`[${new Date().toISOString()}] API server running on port ${port}`);
    console.log(`[${new Date().toISOString()}] Message queue enabled with ${DELAY_BETWEEN_MESSAGES_MS / 1000}s delay between messages`);
    if (!process.env.API_KEY) {
      console.log(`[${new Date().toISOString()}] WARNING: API_KEY not set - API authentication is disabled`);
    }
  });
}
