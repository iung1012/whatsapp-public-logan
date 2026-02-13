# LLM/AI Agent Guide for WhatsApp Logger Bot

This document provides everything an LLM or coding agent needs to set up, configure, and extend this WhatsApp bot from scratch.

## Quick Start (5 Steps)

```bash
# 1. Clone and install
git clone https://github.com/hoodini/whatsapp-logger.git
cd whatsapp-logger
npm install

# 2. Create .env file (see Configuration section below)
cp .env.example .env  # or create manually

# 3. Set up Supabase table (see Database section below)

# 4. Run the bot
npm run dev

# 5. Scan QR code with WhatsApp mobile app
```

## Project Structure

```
whatsapp-logger/
├── src/
│   ├── index.ts           # Entry point - starts connection and API server
│   ├── connection.ts      # WhatsApp connection management, reconnection logic
│   ├── messageHandler.ts  # Message processing, webhook triggers, DM handling
│   ├── mentionWebhook.ts  # Bot mention/reply detection, webhook sending
│   ├── supabase.ts        # Database client, message storage, conversation history
│   ├── api.ts             # Express HTTP API, message queue with rate limiting
│   ├── config.ts          # Allowed groups configuration
│   └── types.ts           # TypeScript interfaces
├── auth_info/             # WhatsApp session (auto-created, gitignored)
├── dist/                  # Compiled JS (after npm run build)
├── .env                   # Environment variables (create this)
└── package.json
```

## Configuration

### Required `.env` File

```env
# Supabase (REQUIRED)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-or-service-role-key

# API Server
API_PORT=7700
API_KEY=your-secret-api-key

# Bot Identity (REQUIRED for mention detection)
BOT_PHONE_NUMBER=972501234567
BOT_LID=1234567890123

# Webhook for AI Integration
MENTION_WEBHOOK_URL=https://hook.eu2.make.com/your-webhook-id
MENTION_API_KEY=your-webhook-api-key

# DM Support (optional)
ENABLE_DM_WEBHOOK=true
```

### Finding Bot Identifiers

After first connection, check logs for:
```
Bot JID: 972501234567:0@s.whatsapp.net  → Use 972501234567 for BOT_PHONE_NUMBER
Bot LID: 1234567890123@lid              → Use 1234567890123 for BOT_LID
```

### Adding Groups to Monitor

Edit `src/config.ts`:
```typescript
export const ALLOWED_GROUPS: AllowedGroup[] = [
  { id: '120363012345678901@g.us', name: 'Group Name' },
];
```

**To find group ID**: Add bot to group → send message → check Supabase `chat_id` column.

## Database Setup

### Supabase Table Schema

```sql
CREATE TABLE whatsapp_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  chat_name TEXT,
  sender_name TEXT,
  sender_number TEXT,
  message_type TEXT,
  body TEXT,
  timestamp BIGINT NOT NULL,
  from_me BOOLEAN DEFAULT FALSE,
  is_group BOOLEAN DEFAULT TRUE,
  is_content BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_chat_id ON whatsapp_messages(chat_id);
CREATE INDEX idx_messages_timestamp ON whatsapp_messages(timestamp DESC);
CREATE INDEX idx_messages_is_content ON whatsapp_messages(is_content);
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Connection status and queue info |
| POST | `/api/send-message` | Send text or image message to specific chat |
| POST | `/api/send-to-all-groups` | Broadcast to all monitored groups |
| GET | `/api/queue` | View pending messages |

### Send Text Message Example

```bash
curl -X POST http://localhost:7700/api/send-message \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{
    "groupId": "120363012345678901@g.us",
    "message": "@User Hello!",
    "mentionNumber": "972501234567"
  }'
```

### Send Image Message Example

```bash
curl -X POST http://localhost:7700/api/send-message \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{
    "groupId": "120363012345678901@g.us",
    "text": "Check out this news!",
    "imageUrl": "https://example.com/image.jpg"
  }'
```

**Fields:**
- `groupId` (required): Chat ID
- `message` or `text`: Message text (caption for images)
- `imageUrl` (optional): If provided, sends image with text as caption
- `mentionNumber` (optional): Phone number to @mention

## Message Flow

```
1. User sends message (group or DM)
   ↓
2. Baileys receives via messages.upsert event
   ↓
3. messageHandler.ts classifies:
   - @g.us → Group message (check if in ALLOWED_GROUPS)
   - @s.whatsapp.net or @lid → DM (check if DM webhook enabled)
   - @broadcast → Ignored
   ↓
4. Save incoming message to Supabase ← NEW: All messages logged
   ↓
5. Check if webhook should trigger:
   - Groups: bot @mentioned or replied to
   - DMs: always trigger (every DM)
   ↓
6. If triggered → POST to MENTION_WEBHOOK_URL with:
   - groupId, groupName, senderNumber, senderName
   - message, messageId, timestamp
   - quotedMessage (if reply)
   - conversationHistory (last 10 messages)
   ↓
7. External service (Make.com) processes and calls back
   ↓
8. /api/send-message receives response
   ↓
9. Message queued with 5s delay between sends
   ↓
10. Bot's response saved to Supabase ← NEW: Outgoing messages logged
```

## Make.com Integration

### Scenario Blueprint

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  1. Webhook     │────▶│  2. Groq/OpenAI │────▶│  3. HTTP POST   │
│  (Trigger)      │     │  (AI Response)  │     │  (Send back)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

### Module 1: Custom Webhook

1. Create new scenario → Add "Webhooks > Custom webhook"
2. Copy webhook URL → Set as `MENTION_WEBHOOK_URL` in `.env`
3. Add header validation:
   - Header: `x-make-apikey`
   - Value: Your `MENTION_API_KEY`

### Module 2: AI (Groq or OpenAI)

**System Prompt:**
```
You are Logan, a helpful assistant in a WhatsApp group.
Keep responses concise (under 200 words).

Context:
- Group: {{1.groupName}}
- User: {{1.senderName}}
- Message: {{1.message}}
{{#if 1.quotedMessage}}
Replying to: {{1.quotedMessage}}
{{/if}}
```

**User Message:**
```
{{1.message}}
```

### Module 3: HTTP Request

**URL:** `https://your-tunnel.trycloudflare.com/api/send-message`

**Method:** POST

**Headers:**
```
Content-Type: application/json
x-api-key: your-api-key
```

**Body (JSON):**
```json
{
  "groupId": "{{1.groupId}}",
  "message": "@{{1.senderName}} {{2.choices[].message.content}}",
  "mentionNumber": "{{1.senderNumber}}"
}
```

### Exposing Local Bot (Cloudflare Tunnel)

```bash
# Install cloudflared
# Windows: scoop install cloudflared
# macOS: brew install cloudflare/cloudflare/cloudflared

# Start tunnel
cloudflared tunnel --url http://localhost:7700
# Output: https://random-name.trycloudflare.com
```

Use this URL in Make.com HTTP module.

## Common Tasks

### Add New Monitored Group

1. Add bot to WhatsApp group
2. Send test message in group
3. Query Supabase: `SELECT chat_id FROM whatsapp_messages ORDER BY created_at DESC LIMIT 1`
4. Add to `src/config.ts`:
   ```typescript
   { id: 'CHAT_ID_HERE@g.us', name: 'Group Name' }
   ```
5. Restart bot

### Enable DM Responses

1. Set `ENABLE_DM_WEBHOOK=true` in `.env`
2. All DMs will trigger webhook
3. DM chat IDs end with `@s.whatsapp.net` or `@lid`

### Change Response Delay

Edit `src/api.ts`:
```typescript
const DELAY_BETWEEN_MESSAGES_MS = 5000; // Change this value
```

### Get Conversation History in Webhook

The webhook payload includes `conversationHistory` array:
```json
{
  "conversationHistory": [
    {"role": "user", "content": "Hello", "senderName": "John"},
    {"role": "assistant", "content": "Hi there!"},
    {"role": "user", "content": "Tell me a joke", "senderName": "John"}
  ]
}
```

## Webhook Payload Reference

```typescript
interface WebhookPayload {
  groupId: string;        // Chat ID (group or DM)
  groupName: string;      // Human-readable name
  senderNumber: string;   // Phone number (may be empty for LID DMs)
  senderName: string;     // WhatsApp display name
  message: string;        // Message content
  messageId: string;      // Unique message ID
  timestamp: number;      // Unix timestamp (seconds)
  quotedMessage?: string; // Message being replied to
  conversationHistory?: Array<{
    role: 'user' | 'assistant';
    content: string;
    senderName?: string;
    timestamp: number;
  }>;
}
```

## Chat ID Formats

| Format | Example | Type |
|--------|---------|------|
| `@g.us` | `120363XXXXXXXXXX@g.us` | Group |
| `@s.whatsapp.net` | `972501234567@s.whatsapp.net` | DM (phone) |
| `@lid` | `8100492890313@lid` | DM (internal ID) |
| `@broadcast` | `status@broadcast` | Ignored |

## Troubleshooting

### Bot not detecting @mentions

1. Check `BOT_LID` matches logs: `Bot LID: XXXXX@lid`
2. WhatsApp uses LID format internally for mentions
3. Verify both `BOT_PHONE_NUMBER` and `BOT_LID` are set

### DMs not triggering webhook

1. Verify `ENABLE_DM_WEBHOOK=true`
2. Check logs for `[DEBUG] Classification: isDM=true`
3. DMs can be `@s.whatsapp.net` OR `@lid` format

### 440 Connection Errors

WhatsApp is rate limiting. The bot has built-in exponential backoff:
- Close all WhatsApp Web sessions
- Wait 5-10 minutes
- Delete `auth_info/` folder and re-scan QR if persistent

### Messages not sending

1. Check `/api/health` - should show `whatsapp: "stable"`
2. Check `/api/queue` - shows pending messages
3. Verify `API_KEY` header matches `.env`

### Webhook returning 401

- Verify `MENTION_API_KEY` matches Make.com header validation
- Header name must be `x-make-apikey`

## Development Commands

```bash
npm run dev      # Run with ts-node (development)
npm run build    # Compile TypeScript
npm start        # Run compiled JS (production)
npm run watch    # Watch mode compilation
```

## Production Deployment

```bash
# Build and run with PM2
npm run build
pm2 start dist/index.js --name whatsapp-logger
pm2 save
pm2 startup
```

## Key Files to Modify

| Task | File |
|------|------|
| Add monitored groups | `src/config.ts` |
| Change message processing | `src/messageHandler.ts` |
| Modify webhook payload | `src/mentionWebhook.ts` |
| Add API endpoints | `src/api.ts` |
| Change connection behavior | `src/connection.ts` |
| Modify database queries | `src/supabase.ts` |

## Dependencies

- `@whiskeysockets/baileys` - WhatsApp Web API
- `@supabase/supabase-js` - Database client
- `express` - HTTP API server
- `dotenv` - Environment variables
- `pino` - Logger (Baileys requirement)
- `qrcode-terminal` - QR code display
