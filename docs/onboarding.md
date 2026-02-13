# Logan - Onboarding Guide

A step-by-step guide for setting up your own Logan instance.

---

## Prerequisites

Before you begin, ensure you have:

- **Node.js 18+** installed ([download](https://nodejs.org/))
- **A dedicated WhatsApp number** (do not use your personal number)
- **Supabase account** (free tier works) - [supabase.com](https://supabase.com)
- **API Keys** from:
  - Groq (for chat responses + voice transcription)
  - Anthropic/Claude (for daily summaries)
  - ElevenLabs (for voice summaries - optional)
- **A server/VPS** to run Logan 24/7 (or local machine for testing)

---

## Step 1: Clone & Install

```bash
git clone https://github.com/hoodini/whatsapp-logger.git
cd whatsapp-logger
npm install
```

---

## Step 2: Supabase Setup

### 2.1 Create Account & Project

1. Go to [supabase.com](https://supabase.com) and create an account
2. Click "New Project"
3. Choose a name and set a database password
4. Wait for the project to be created (1-2 minutes)

### 2.2 Create the Messages Table

1. Go to **SQL Editor** in the left sidebar
2. Click "New Query"
3. Paste and run this SQL:

```sql
-- Create the messages table
CREATE TABLE whatsapp_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  chat_name TEXT,
  sender_name TEXT,
  sender_number TEXT,
  message_type TEXT,
  body TEXT,
  timestamp BIGINT,
  from_me BOOLEAN DEFAULT false,
  is_group BOOLEAN DEFAULT false,
  is_content BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX idx_whatsapp_messages_chat_id ON whatsapp_messages(chat_id);
CREATE INDEX idx_whatsapp_messages_timestamp ON whatsapp_messages(timestamp);
CREATE INDEX idx_whatsapp_messages_sender_number ON whatsapp_messages(sender_number);
CREATE INDEX idx_whatsapp_messages_is_content ON whatsapp_messages(is_content);
```

### 2.3 Get Your Credentials

1. Go to **Settings > API** in the left sidebar
2. Copy:
   - **Project URL** (looks like `https://xxxxx.supabase.co`)
   - **anon/public key** (starts with `eyJ...`)

---

## Step 3: Get API Keys

| Service | URL | Purpose | Free Tier |
|---------|-----|---------|-----------|
| **Groq** | [console.groq.com](https://console.groq.com) | Chat responses + Whisper transcription | Yes |
| **Anthropic** | [console.anthropic.com](https://console.anthropic.com) | Daily summaries (Claude) | $5 credit |
| **ElevenLabs** | [elevenlabs.io](https://elevenlabs.io) | Voice summaries (TTS) | 10k chars/month |

### Getting Each Key:

**Groq:**
1. Sign up at console.groq.com
2. Go to API Keys
3. Create new key, copy it (starts with `gsk_`)

**Anthropic:**
1. Sign up at console.anthropic.com
2. Go to API Keys
3. Create new key, copy it (starts with `sk-ant-`)

**ElevenLabs (optional):**
1. Sign up at elevenlabs.io
2. Go to Profile > API Keys
3. Copy your API key

---

## Step 4: Configure Environment

### 4.1 Create Your .env File

```bash
cp .env.example .env
```

### 4.2 Edit the Configuration

Open `.env` in your editor and fill in all values:

```env
# ===================
# SUPABASE DATABASE
# ===================
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# ===================
# API KEYS
# ===================
# Groq - For chat responses and voice transcription
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxx

# Anthropic - For daily summaries
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxx

# ElevenLabs - For voice summaries (optional)
ELEVENLABS_API_KEY=your_elevenlabs_key
ELEVENLABS_VOICE_ID=3JZUpoTOGG7akwuTH0DK

# ===================
# BOT SETTINGS
# ===================
API_PORT=7700
API_KEY=generate-a-secure-random-string-here
BOT_PHONE_NUMBER=972501234567

# ===================
# DAILY SUMMARY
# ===================
DAILY_SUMMARY_ENABLED=true
DAILY_SUMMARY_TIME=22:00

# ===================
# SHABBAT SETTINGS
# ===================
SHABBAT_ENABLED=true
# Jerusalem for candle lighting (lock time)
SHABBAT_LOCK_LOCATION=281184
# Haifa for havdalah (unlock time)
SHABBAT_UNLOCK_LOCATION=294801
# Lock 30 min before candle lighting
SHABBAT_LOCK_OFFSET=-30
# Unlock 30 min after havdalah
SHABBAT_UNLOCK_OFFSET=30

# ===================
# SPAM DETECTION
# ===================
SPAM_DETECTION_ENABLED=true
# Comma-separated phone numbers that can't be banned
SPAM_WHITELIST=
```

> **Note**: Generate a secure API_KEY using: `openssl rand -hex 32`

---

## Step 5: First Run & WhatsApp Connection

### 5.1 Start Logan

```bash
npm start
```

### 5.2 Scan QR Code

1. A QR code will appear in your terminal
2. Open WhatsApp on your **dedicated bot phone**
3. Go to **Settings > Linked Devices > Link a Device**
4. Scan the QR code
5. Wait for "Connected!" message in the logs

### 5.3 Verify Connection

You should see logs like:
```
[2024-01-15T10:00:00.000Z] Connected to WhatsApp!
[2024-01-15T10:00:00.000Z] Bot JID: 972501234567@s.whatsapp.net
[2024-01-15T10:00:10.000Z] Connection stable for 10s - ready for messages
```

---

## Step 6: Configure Monitored Groups

### 6.1 Get Group IDs

After connecting, send a message in each group you want to monitor. Logan will log:

```
[MESSAGE] Group: My Group Name (120363XXXXXXXXXX@g.us)
```

The part in parentheses (`120363XXXXXXXXXX@g.us`) is the group ID.

### 6.2 Update Configuration

Edit `src/config.ts` to add your groups:

```typescript
export const ALLOWED_GROUPS: AllowedGroup[] = [
  { id: '120363XXXXXXXXXX@g.us', name: 'My First Group' },
  { id: '120363YYYYYYYYYY@g.us', name: 'My Second Group' },
  // Add more groups as needed
];
```

### 6.3 Rebuild and Restart

```bash
npm run build
# Restart Logan (Ctrl+C and npm start, or pm2 restart logan)
```

---

## Step 7: Set Bot as Group Admin

For Shabbat lock/unlock and spam removal to work, the bot **must be admin** in each group:

1. Open each monitored group in WhatsApp
2. Tap the group name to open **Group Info**
3. Scroll down to the participants list
4. Long press on the bot's phone number
5. Select **"Make group admin"**

Repeat for all monitored groups.

---

## Step 8: Customize Logan's Personality

Edit `src/prompts/logan.ts` to customize the bot's behavior:

```typescript
export const LOGAN_SYSTEM_PROMPT = `You are [Your Bot Name].

// Define personality and tone
// Set what topics it responds to
// Add contact information
// Set response limits

Important: max 520 characters per response.`;
```

Rebuild after changes:
```bash
npm run build
```

---

## Step 9: Test Everything

### API Health Check
```bash
curl http://localhost:7700/api/health
```

Expected response:
```json
{"status":"ok","whatsapp":"stable","queue":{"size":0,"processing":false}}
```

### Test Daily Summary
```bash
curl http://localhost:7700/api/test-daily-summary
```

### Test Shabbat Lock/Unlock
```bash
# Lock all groups (test)
curl http://localhost:7700/api/test-shabbat-lock

# Unlock all groups
curl http://localhost:7700/api/test-shabbat-unlock
```

### Test Mention Response
Tag the bot in a group message and wait for response.

### Test Voice Message
Send a voice message in DM to the bot (or tag it in a group voice message).

### Test Broadcast
```bash
curl -X POST http://localhost:7700/api/broadcast \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello from Logan!"}'
```

---

## Step 10: Run in Production

### Option A: PM2 (Recommended)

```bash
# Install PM2 globally
npm install -g pm2

# Start Logan with PM2
pm2 start npm --name logan -- start

# Save the process list
pm2 save

# Set up auto-start on boot
pm2 startup
# Run the command it outputs
```

**Useful PM2 Commands:**
```bash
pm2 logs logan      # View logs
pm2 restart logan   # Restart
pm2 stop logan      # Stop
pm2 monit           # Monitor dashboard
```

### Option B: Systemd (Linux)

Create `/etc/systemd/system/logan.service`:

```ini
[Unit]
Description=Logan WhatsApp Bot
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/path/to/whatsapp-logger
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable logan
sudo systemctl start logan
sudo systemctl status logan
```

### Option C: Docker

```bash
# Build image
docker build -t logan .

# Run container
docker run -d \
  --name logan \
  --env-file .env \
  -p 7700:7700 \
  -v $(pwd)/auth_info_baileys:/app/auth_info_baileys \
  logan
```

---

## Exposing API Externally (Optional)

If you need to access the API from outside (webhooks, etc.):

### Cloudflare Tunnel (Recommended - Free)

```bash
# Install cloudflared
# Then run:
cloudflared tunnel --url http://localhost:7700
```

### Nginx Reverse Proxy

```nginx
server {
    listen 443 ssl;
    server_name logan.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:7700;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## Troubleshooting

### QR Code Not Appearing

```bash
# Delete auth folder and restart
rm -rf auth_info_baileys
npm start
```

### Messages Not Logging

1. Check Supabase credentials in `.env`
2. Verify the table exists (run SQL again)
3. Check the group is in `ALLOWED_GROUPS` in config.ts

### Bot Not Responding to Mentions

1. Verify `BOT_PHONE_NUMBER` matches your WhatsApp number
2. Check `GROQ_API_KEY` is valid
3. Look for errors in the logs

### Shabbat Lock Not Working

1. Bot must be admin in the group
2. Verify `SHABBAT_ENABLED=true`
3. Test permissions: `curl http://localhost:7700/api/test-lock/GROUP_ID`

### Voice Transcription Failing

1. Check `GROQ_API_KEY` is set
2. Audio file might be too large (max 25MB)
3. Check logs for specific error messages

### Daily Summary Not Sending

1. Verify `DAILY_SUMMARY_ENABLED=true`
2. Check `ANTHROPIC_API_KEY` is valid
3. Ensure there are messages in the last 24 hours

### Connection Keeps Dropping

1. Don't open WhatsApp Web in a browser (conflicts with Baileys)
2. Check internet stability
3. Look for 440 errors (WhatsApp rate limiting)

---

## Feature Toggle Reference

| Feature | Environment Variable | Default | Description |
|---------|---------------------|---------|-------------|
| Daily Summary | `DAILY_SUMMARY_ENABLED` | `false` | Text + voice daily summaries |
| Shabbat Lock | `SHABBAT_ENABLED` | `false` | Auto lock/unlock groups |
| Spam Detection | `SPAM_DETECTION_ENABLED` | `false` | Detect and remove spam |
| Voice Summaries | `ELEVENLABS_API_KEY` | - | Set to enable TTS |

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Connection status |
| `/api/send-message` | POST | Send message to specific group |
| `/api/broadcast` | POST | Send to all monitored groups |
| `/api/test-daily-summary` | GET | Trigger daily summary now |
| `/api/test-shabbat-lock` | GET | Lock all groups |
| `/api/test-shabbat-unlock` | GET | Unlock all groups |
| `/api/shabbat` | GET | Get Shabbat schedule status |
| `/api/queue` | GET | View message queue |

All `/api/*` endpoints require `x-api-key` header if `API_KEY` is set in `.env`.

---

## Support

For issues and questions:
- GitHub Issues: [github.com/hoodini/whatsapp-logger/issues](https://github.com/hoodini/whatsapp-logger/issues)

---

## Related Documentation

- [Phone Number Change Guide](phone-change.md)
- [README](../README.md)
