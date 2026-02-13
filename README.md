# Logan - Unofficial WhatsApp AI Bot 🤖

> **Created by [Yuval Avidani](https://yuv.ai)** | 2x GitHub Star ⭐⭐ | 2x AWS Gen AI Superstar 🌟🌟 | AI Speaker & Builder

> **Note**: This is an **unofficial, community-maintained** implementation of a WhatsApp AI bot. It is not affiliated with or endorsed by WhatsApp, Meta, or any official Logan project.

A powerful, self-hosted WhatsApp bot built with Node.js and Baileys that brings AI intelligence to your WhatsApp groups. Logan provides intelligent group management, AI-powered responses, daily summaries, voice transcription, and automated Shabbat scheduling.

**Built with ❤️ for the open source community by [@hoodini](https://github.com/hoodini)**

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License"/>
  <img src="https://img.shields.io/badge/Node.js-18%2B-green.svg" alt="Node.js"/>
  <img src="https://img.shields.io/badge/TypeScript-5.3%2B-blue.svg" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/Author-Yuval%20Avidani-blueviolet" alt="Author"/>
</p>

<p align="center">
  <a href="https://github.com/hoodini">GitHub</a> •
  <a href="https://twitter.com/yuvalav">Twitter/X</a> •
  <a href="https://instagram.com/yuval_770">Instagram</a> •
  <a href="https://youtube.com/@yuv-ai">YouTube</a> •
  <a href="https://yuv.ai">Blog</a> •
  <a href="https://linktr.ee/yuvai">Linktree</a>
</p>

---

## 📖 Table of Contents

- [What is Logan?](#what-is-logan)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Detailed Setup Guide](#detailed-setup-guide)
- [Configuration](#configuration)
- [Security](#security)
- [API Endpoints](#api-endpoints)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## What is Logan?

Logan is a **self-hosted WhatsApp bot** that runs on your own server/computer using your own WhatsApp account. Think of it as your personal AI assistant that lives inside WhatsApp groups.

### What Logan Does

- 📝 **Logs all group messages** to a database for archival and analysis
- 🤖 **Responds intelligently** when @mentioned, using AI to understand context
- 📊 **Generates daily summaries** of group discussions automatically
- 🎤 **Transcribes voice messages** so you can read instead of listen
- 🕯️ **Respects Shabbat** by automatically locking groups before Shabbat and unlocking after havdalah
- 🚫 **Detects and removes spam** using AI-powered analysis
- 🔊 **Creates voice summaries** using text-to-speech for accessibility

### Why Use Logan?

- **Privacy-First**: Your data stays on your own infrastructure (Supabase account)
- **Customizable**: Full control over behavior, scheduling, and features
- **Open Source**: Inspect, modify, and extend the code as you wish
- **Community-Driven**: Built by the community, for the community
- **Hebrew Support**: Built with Hebrew-speaking communities in mind

---

## ✨ Complete Feature List

Logan is packed with features designed for intelligent group management and AI-powered interactions.

### 🤖 AI & Natural Language

#### Intelligent Mention Responses
- **Context-Aware Conversations**: Logan understands conversation context from recent messages (15 group messages, 5 user messages)
- **Multi-Language Support**: Works in Hebrew, English, and mixed conversations
- **Personality**: Warm, helpful, and culturally aware (Israeli tech community optimized)
- **Smart Triggers**: Responds to @mentions, "logan", "לוגן" keywords
- **Rate Limiting**: 3 responses per user per minute to prevent spam
- **LLM Backend**: Powered by Groq API (LLaMA 3.3 70B / GPT-4 class performance)

#### Daily Summaries
- **Automated Daily Recaps**: AI-generated summaries of group discussions at scheduled time (default 22:00 Israel time)
- **Multi-Group Support**: Can summarize multiple groups separately
- **Master Channel**: Optional unified summary combining all groups
- **Erev Shabbat Awareness**: Sends summaries early (30 min before candle lighting) on Friday
- **Smart Filtering**: Only includes meaningful content (ignores system messages)
- **LLM Backend**: Powered by Claude 3.5 Sonnet for high-quality summaries

#### Voice Features
- **Voice Message Transcription**: Automatic transcription of voice messages using Whisper (Groq)
- **Voice Summaries**: Text-to-speech summaries using ElevenLabs TTS (optional)
- **Anti-Cutoff**: Smart chunking prevents voice messages from cutting mid-sentence
- **Hebrew Support**: Handles Hebrew text-to-speech naturally

#### Web Search Integration
- **Real-Time Search**: Fetches fresh data from the web via Tavily API
- **Source Citations**: Always includes sources with URLs
- **Hallucination Detection**: Detects and filters fake URLs from LLM responses
- **Smart Triggers**: Activates for queries needing current information
- **Cached Results**: 2-hour cache to save API calls
- **Authorization**: Configurable per-user or per-group access

---

### 🛡️ Group Management & Safety

#### Shabbat Auto-Lock System (4-Layer Protection)
**The most comprehensive Shabbat protection system:**

1. **Hebcal API Integration**
   - Fetches candle lighting and havdalah times for any city worldwide
   - Supports configurable offsets (e.g., -30 min before, +30 min after)
   - Different locations for lock/unlock (lock in Jerusalem, unlock in Tel Aviv)

2. **Cache Layer**
   - Local cache file (`shabbat_times_cache.json`) prevents API failures
   - Updates automatically every Friday morning
   - Fallback if API is unreachable

3. **Lock State File**
   - Persistent state tracking (`shabbat_lock_state.json`)
   - Survives restarts and reconnects
   - Prevents duplicate lock/unlock operations

4. **Timezone Fallback**
   - If all else fails, uses Israel timezone assumptions
   - Friday 3 PM → Saturday 9 PM default window

**How it Works:**
- **Before Shabbat**: Groups set to "announcement mode" (only admins can post)
- **After Havdalah**: Groups unlocked with "שבוע טוב" greeting
- **All Paths Protected**: Every message-sending function checks Shabbat status
- **Early Check**: Shabbat checked 3 seconds after connection (before stability timer)

#### Spam Detection & Removal
- **AI-Powered Detection**: LLM analyzes message context, not just keywords
- **Two-Strike System**:
  - First offense: Warning message
  - Second offense: Automatic removal from group
- **Pre-Filter**: Catches obvious spam before LLM analysis (saves API costs)
- **Whitelist Support**: Protect trusted users from false positives
- **Admin Notifications**: DMs admins when spam is detected or removed
- **Configurable**: Enable/disable per group or globally

#### Join Request Auto-Processing
**Intelligent bot detection and auto-approval:**

- **Bot Detection Algorithm**:
  - No profile picture: +2 suspicion score
  - Bot-like name patterns: +2 suspicion score
  - Suspicious phone number patterns: +1 suspicion score
  - Threshold ≥3: Auto-reject (likely bot)
  - Threshold <3: Auto-approve (likely human)

- **Group Size Enforcement**: Configurable max members (default 1024)
- **Daily Processing**: Automated check at scheduled time (default 09:00)
- **Shabbat Aware**: Skips processing during Shabbat
- **Admin Notifications**: DMs admins with processing results
- **Manual Override**: Script for manual processing when needed

#### Broadcast System
- **Multi-Group Announcements**: Send messages to all monitored groups at once
- **Duplicate Prevention**: Supabase-backed atomic locks prevent double-sends
- **Partial Recovery**: Tracks which groups received message if interrupted
- **Race Condition Protection**: Handles multiple bot instances running simultaneously
- **Restart Resilience**: Survives bot restarts mid-broadcast

---

### 📊 Data & Logging

#### Message Logging
- **Complete Archive**: All group messages logged to Supabase PostgreSQL database
- **Rich Metadata**: Sender, timestamp, message type, group info, from_me flag
- **Content Types**: Text, images, videos, audio, documents, stickers, voice, polls, locations
- **System Messages**: Optional logging of joins, leaves, admin changes
- **Privacy Controls**: Configure which groups to monitor via `ALLOWED_GROUPS`

#### Auth State Management
- **Database-Backed Sessions**: WhatsApp multi-device session stored in Supabase
- **Persistent Across Restarts**: No need to re-scan QR after restarts
- **Sync Across Instances**: Multiple instances can share auth state
- **Automatic Cleanup**: Old session data automatically purged

#### Broadcast Guard Table
- **Operation Tracking**: Tracks all broadcast operations (daily summaries, Shabbat locks)
- **Atomic Locking**: Prevents race conditions between multiple instances
- **Status Tracking**: started → completed/failed
- **Partial State**: Remembers which groups received message for recovery

#### Pending Responses Queue
- **Failed Message Retry**: Stores responses that couldn't be delivered
- **Automatic Retry**: Retries when connection restored
- **Response Types**: Landing pages, videos, agent responses
- **Retry Tracking**: Counts retry attempts

---

### ⚙️ Advanced Features

#### Admin Authorization System
- **Multi-Tier Access Control**:
  - **Admin Numbers**: Full access to all features in any group/DM
  - **Public Groups**: All users can use features in specific groups
  - **Free Chat Groups**: All users can text chat (no tools)

- **Feature-Specific Auth**: Separate auth for agent, mentions, Tavily search
- **Admin-Only Mode**: Lock down bot to admins only for testing
- **Flexible Configuration**: Mix public groups + admin users

#### Connection Resilience
- **Exponential Backoff**: Smart retry with jitter for 440 errors
- **Session Replaced Handling**: Detects and recovers from multiple device conflicts
- **Stability Timer**: 10-second wait before "stable" confirmation
- **Early Shabbat Check**: Validates Shabbat status at 3 seconds (before stability timer)
- **Conservative Settings**: Tuned WebSocket settings to prevent bans

#### Rate Limiting & Cooldowns
- **Per-User Rate Limit**: 3 responses per user per minute
- **Daily Summary Cooldown**: 1 summary per group per 23 hours
- **Voice Summary Cooldown**: Prevents spam of TTS messages
- **API Token Tracking**: Monitors Groq daily token usage (200K limit)

#### Group Filtering
- **Selective Monitoring**: Choose which groups to monitor via `ALLOWED_GROUPS` JSON array
- **Default All-Groups**: Monitors all groups if not configured
- **Priority Ordering**: Lock/unlock groups in specified order
- **Channel Support**: Handles WhatsApp Channels (newsletters)

#### API Server
- **REST API**: Express server on port 7700 (configurable)
- **Authentication**: Optional API key protection
- **Health Checks**: `/api/health` endpoint with connection status
- **Message Queue**: `/api/queue` shows pending operations
- **Group List**: `/api/groups` returns all monitored groups
- **Manual Triggers**: Endpoints to manually trigger summaries, lock/unlock, etc.

---

### 🔧 Developer Features

#### Configurable Everything
- **90+ Environment Variables**: Every behavior is configurable
- **JSON Configuration**: Group lists, admin lists via JSON in env vars
- **Feature Flags**: Enable/disable any feature independently
- **Time Scheduling**: Configure times for summaries, join processing, etc.

#### Extensible Architecture
- **Modular Services**: Groq, Claude, Tavily, ElevenLabs, Whisper services
- **Feature Modules**: Daily summary, mention response, broadcast as separate modules
- **Event-Driven**: Message handler dispatches to appropriate features
- **Database-First**: Supabase for state, messages, auth, guards

#### Observability
- **Structured Logging**: Pino logger with configurable levels (info/debug/warn/error)
- **Operation Tracking**: All broadcasts, summaries tracked in database
- **Error Handling**: Graceful error recovery with detailed logging
- **Debug Scripts**: Included scripts for debugging admin status, join requests

#### TypeScript
- **Type Safety**: Full TypeScript codebase
- **Interfaces**: Clear type definitions for messages, configs, responses
- **Compile-Time Checks**: Catch errors before runtime
- **IDE Support**: IntelliSense and autocomplete

---

### 🌐 Multi-Language & Localization

- **Hebrew Primary**: Built for Hebrew-speaking communities
- **English Support**: Full English language support
- **Mixed Conversations**: Handles Hebrew + English naturally
- **Hebrew Calendar**: Integrates with Jewish calendar (Hebcal)
- **Israeli Timezone**: Defaults to Asia/Jerusalem timezone
- **Cultural Awareness**: Shabbat greetings, Israeli tech community tone

---

## 📋 Prerequisites

Before you begin, make sure you have:

### Required

1. **Node.js 18+** - [Download here](https://nodejs.org/)
2. **A spare WhatsApp account** - Cannot use your main WhatsApp on the same device
   - Get a new SIM card or Google Voice number
   - This will become the bot's WhatsApp account
3. **Supabase account** - [Sign up free](https://supabase.com)
   - Free tier includes: 500MB database, 2GB bandwidth/month
   - Used for message storage and state management
4. **API Keys** (all have free tiers):
   - [Groq API](https://console.groq.com) - For AI responses (200K tokens/day free)
   - [Anthropic API](https://console.anthropic.com) - For daily summaries ($5 credit)

### Optional

- [ElevenLabs API](https://elevenlabs.io) - For voice summaries (10K chars/month free)
- [Tavily API](https://tavily.com) - For web search (1K searches/month free)

### Technical Knowledge

- Basic command line/terminal usage
- Ability to edit configuration files
- Understanding of environment variables

---

## 🚀 Quick Start

Get Logan running in 5 minutes:

```bash
# 1. Clone the repository
git clone https://github.com/hoodini/whatsapp-logger.git
cd whatsapp-logger

# 2. Install dependencies
npm install

# 3. Create environment file
cp .env.example .env

# 4. Edit .env with your API keys (use nano, vim, or any text editor)
nano .env

# 5. Build the TypeScript code
npm run build

# 6. Start the bot
npm start

# 7. Scan QR code with your bot's WhatsApp
# Open WhatsApp on the phone you want to use as the bot
# Go to: Settings > Linked Devices > Link a Device
# Scan the QR code that appears in the terminal
```

✅ **That's it!** Logan is now running and will respond when mentioned in groups.

---

## 📚 Detailed Setup Guide

**Read this if:** You're new to coding, databases, or setting up bots.

### Step 1: Create a Supabase Database

**What is Supabase?** It's a free online database where Logan will save all WhatsApp messages.

**Why do I need this?** Without a database, Logan can't remember messages or create summaries.

#### 1.1 Sign Up for Supabase (Free)

1. Go to **[supabase.com](https://supabase.com)** in your web browser
2. Click the **"Start your project"** button (big green button)
3. Sign up with your GitHub account or email
4. Verify your email if asked

#### 1.2 Create a New Project

1. After signing in, click **"New Project"**
2. Fill in:
   - **Name**: `logan-bot` (or any name you want)
   - **Database Password**: Create a strong password (SAVE THIS!)
   - **Region**: Choose closest to you (e.g., "US East" if you're in USA)
3. Click **"Create new project"**
4. Wait 2-3 minutes for setup to complete

#### 1.3 Get Your Database Credentials

These are like keys to access your database.

1. In your Supabase project, click **"Settings"** (gear icon on left sidebar)
2. Click **"API"** in the settings menu
3. You'll see two important things:
   - **Project URL**: Looks like `https://abcdefgh.supabase.co`
   - **anon public key**: Long text starting with `eyJ...`
4. **Copy these** - you'll need them soon!

> 💡 **Tip**: Open Notepad and paste these there temporarily so you don't lose them.

#### 1.4 Create the Database Tables

**What are tables?** Like spreadsheets where Logan stores messages.

1. In Supabase, click **"SQL Editor"** on the left sidebar
2. Click **"New Query"** button
3. Copy and paste this entire code block into the editor:

```sql
-- Main messages table
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

-- Auth state table (for multi-device session storage)
CREATE TABLE IF NOT EXISTS whatsapp_auth_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Broadcast guard table (prevents duplicate broadcasts)
CREATE TABLE IF NOT EXISTS broadcast_guard (
  id SERIAL PRIMARY KEY,
  operation_key TEXT NOT NULL,
  broadcast_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started',
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  run_id TEXT NOT NULL,
  groups_sent TEXT[] DEFAULT '{}',
  error_message TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_guard_active_lock
  ON broadcast_guard(operation_key) WHERE status = 'started';

CREATE INDEX IF NOT EXISTS idx_broadcast_guard_key ON broadcast_guard(operation_key);

-- Pending responses table (for failed message delivery)
CREATE TABLE IF NOT EXISTS pending_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id TEXT NOT NULL,
  sender_number TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  response TEXT NOT NULL,
  response_type TEXT NOT NULL CHECK (response_type IN ('landing_page', 'video', 'agent')),
  retry_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_responses_created_at
  ON pending_responses(created_at ASC);
```

4. Click the **"Run"** button (or press F5)
5. You should see "Success. No rows returned" - that's good!

**What just happened?** You created 4 "tables" (like 4 spreadsheets) where Logan will store:
- All WhatsApp messages
- Bot's login session
- Broadcast tracking (to prevent duplicate messages)
- Failed messages (to retry later)

---

### Step 2: Get API Keys (The AI Brains)

**What are API keys?** Think of them like passwords that let Logan use AI services to respond smartly.

**Why do I need multiple?** Each service does something different:
- **Groq**: Fast AI responses when people @mention Logan
- **Anthropic (Claude)**: Creates daily summaries
- **ElevenLabs**: Turns summaries into voice messages (optional)
- **Tavily**: Searches the web for fresh info (optional)

#### 2.1 Get Groq API Key (Required - FREE)

**What it does**: Makes Logan respond intelligently when mentioned in groups.

1. Go to **[console.groq.com](https://console.groq.com)**
2. Click **"Sign in with Google"** (or use email)
3. After login, look for **"API Keys"** on the left menu
4. Click **"Create API Key"** button
5. Give it a name like `logan-bot`
6. Copy the key - it starts with `gsk_...`
7. Paste it in your Notepad (don't lose it!)

> 💡 **Tip**: Free tier gives you 200,000 tokens/day (that's like 50,000 messages)

#### 2.2 Get Anthropic API Key (Required - $5 FREE CREDIT)

**What it does**: Creates daily summaries of group discussions.

1. Go to **[console.anthropic.com](https://console.anthropic.com)**
2. Click **"Get API Keys"**
3. Sign up with email
4. Verify your email
5. After login, click **"Get API Keys"** again
6. Click **"Create Key"** button
7. Copy the key - it starts with `sk-ant-...`
8. Paste it in your Notepad

> 💰 **Cost**: You get $5 free credit. Daily summaries cost ~$0.01 each, so 500 summaries free!

#### 2.3 Get ElevenLabs Key (Optional - Voice Summaries)

**What it does**: Turns text summaries into voice messages (cool but not required).

**Skip this if**: You don't need voice summaries.

1. Go to **[elevenlabs.io](https://elevenlabs.io)**
2. Sign up for free
3. Click your profile picture → **"Profile"**
4. Look for **"API Key"**
5. Copy and save it

---

### Step 3: Install Node.js (The Engine)

**What is Node.js?** The programming language runtime that runs Logan.

**Do I have it already?** Let's check!

#### 3.1 Check if Node.js is Installed

Open your terminal/command prompt:
- **Windows**: Press `Windows + R`, type `cmd`, press Enter
- **Mac**: Press `Cmd + Space`, type `terminal`, press Enter
- **Linux**: Press `Ctrl + Alt + T`

Type this command and press Enter:
```bash
node --version
```

**If you see:** `v18.x.x` or higher → Great! Skip to Step 4.

**If you see:** Error or version below 18 → Continue below.

#### 3.2 Install Node.js

1. Go to **[nodejs.org](https://nodejs.org)**
2. Download the **LTS** version (left button - has "Recommended" label)
3. Run the installer
4. Click "Next" until it installs
5. Restart your terminal
6. Type `node --version` again - should see v20.x.x or similar

---

### Step 4: Download and Install Logan

#### 4.1 Download the Code

Open your terminal and type these commands one by one:

```bash
# Download Logan's code
git clone https://github.com/hoodini/whatsapp-logger.git

# Enter the folder
cd whatsapp-logger

# Install required packages (takes 1-2 minutes)
npm install
```

**What's happening?**
- `git clone`: Downloads Logan's code to your computer
- `cd whatsapp-logger`: Goes into the Logan folder
- `npm install`: Downloads 50+ helper libraries Logan needs

**If git command fails**: You need to install Git first from [git-scm.com](https://git-scm.com)

#### 4.2 Create Your Configuration File

```bash
# Windows
copy .env.example .env

# Mac/Linux
cp .env.example .env
```

**What just happened?** You created a `.env` file - this is where your secret keys go.

---

### Step 5: Configure Your Bot (Fill in the Secrets)

Now we'll edit the `.env` file with all those keys you saved earlier.

#### 5.1 Open the File

**Windows**: Right-click `.env` → Open with → Notepad
**Mac**: Double-click `.env` (opens in TextEdit)
**Linux**: Use `nano .env` or your favorite editor

#### 5.2 Fill in Your Information

Find each line and paste your keys:

**Database (from Step 1.3):**

```env
SUPABASE_URL=https://abc123.supabase.co
SUPABASE_KEY=eyJ...your-long-key...
```

**AI Keys (from Step 2):**
```env
GROQ_API_KEY=gsk_...your-groq-key...
ANTHROPIC_API_KEY=sk-ant-...your-anthropic-key...
ELEVENLABS_API_KEY=...your-elevenlabs-key...  # Optional - leave empty if you didn't get one
```

**Bot's Phone Number:**

This is the WhatsApp number that will become the bot. Format: numbers only, no + or dashes.

```env
BOT_PHONE_NUMBER=972501234567  # Replace with your bot's number
```

**Security Key:**

Generate a random password for the API:

```bash
# Windows (in PowerShell):
-join ((65..90) + (97..122) + (48..57) | Get-Random -Count 32 | % {[char]$_})

# Mac/Linux:
openssl rand -hex 32
```

Copy the result and paste:
```env
API_KEY=a3f9d8e2b1c4...your-random-key...
```

**Features - Leave These As-Is for Now:**
```env
DAILY_SUMMARY_ENABLED=true
DAILY_SUMMARY_TIME=22:00
SHABBAT_ENABLED=true
SPAM_DETECTION_ENABLED=true
```

> 💡 **Don't worry about the advanced settings yet!** The defaults work fine for beginners.

#### 5.3 Save the File

- Press `Ctrl + S` (Windows/Linux) or `Cmd + S` (Mac)
- Close the editor

---

### Step 6: Start Logan!

Almost there! Now we'll turn Logan on.

#### 6.1 Build the Code

In your terminal (still in the `whatsapp-logger` folder):

```bash
npm run build
```

**What's happening?** Converting TypeScript code to JavaScript (takes 10-30 seconds).

**If you see errors**: Make sure you filled in the `.env` file correctly. Check for typos!

#### 6.2 Start Logan

```bash
npm start
```

**You should see:**
```
[INFO] Starting WhatsApp bot...
[INFO] API server listening on port 7700
[INFO] Connecting to WhatsApp...
```

Then a **QR CODE** will appear! 📱

---

### Step 7: Connect Your WhatsApp

**This is the magic moment!** You'll link WhatsApp to Logan.

#### 7.1 Scan the QR Code

1. Open **WhatsApp** on the phone that will be the bot
   - ⚠️ **Important**: This phone cannot use WhatsApp normally anymore! Use a spare phone or new SIM.

2. In WhatsApp:
   - Tap the **three dots** (⋮) in top right
   - Tap **"Linked Devices"**
   - Tap **"Link a Device"**

3. **Scan the QR code** from your computer screen

4. Wait 5-10 seconds...

**Success!** You should see:
```
[INFO] WhatsApp connection established
[INFO] Bot JID: 972501234567@s.whatsapp.net
```

🎉 **Logan is alive!**

---

### Step 8: Test Logan

Let's make sure everything works!

#### 8.1 Add Logan to a Test Group

1. Create a new WhatsApp group (or use an existing one)
2. Add your bot's number to the group
3. **Important**: Make the bot an admin!
   - Tap group name
   - Scroll to bot's number
   - Long press → Make group admin

#### 8.2 Test Mention Response

In the group, send this message:
```
@Logan hello! are you working?
```

**Logan should reply** within a few seconds! 🎉

If it doesn't reply:
- Check the terminal for errors
- Make sure you @mentioned the exact name saved in your contacts
- Check that `BOT_PHONE_NUMBER` in `.env` matches exactly (no + or -)

---

### Step 9: What's Next?

**Logan is running!** But only while your terminal is open. Here's what to do:

#### Keep Logan Running 24/7

**For beginners**: Just leave your computer and terminal open.

**For advanced users**: Set up PM2 (see [Production Deployment](#-production-deployment) section below).

#### Optional Features to Enable

Want more features? Edit your `.env` file:

**Shabbat Auto-Lock** (for Jewish users):
```env
SHABBAT_ENABLED=true
SHABBAT_LOCK_LOCATION=281184  # Jerusalem
```
Find your city: [geonames.org](https://www.geonames.org)

**Daily Summaries**:
Already enabled! Logan will send a summary at 22:00 Israel time daily.

**Web Search** (optional):
Get a free key at [tavily.com](https://tavily.com) and add:
```env
TAVILY_API_KEY=tvly-...your-key...
```

---

### 🆘 Help! Something's Not Working

#### "Bot not responding to @mentions"

1. Check `BOT_PHONE_NUMBER` in `.env` matches your number exactly
2. The contact name must match what you @mentioned
3. Try restarting: Press `Ctrl+C` in terminal, then `npm start` again

#### "QR code won't appear"

1. Check your internet connection
2. Make sure port 7700 isn't already in use
3. Try deleting the `auth_info` folder and running `npm start` again

#### "Database errors"

1. Check `SUPABASE_URL` and `SUPABASE_KEY` are correct
2. Make sure you ran the SQL from Step 1.4
3. Check Supabase dashboard - project might be paused

#### "API key invalid"

1. Double-check the keys in `.env` - no extra spaces!
2. Make sure keys start with correct prefix:
   - Groq: `gsk_`
   - Anthropic: `sk-ant-`
3. Test keys at their respective console websites

**Still stuck?** Open an issue on [GitHub](https://github.com/hoodini/whatsapp-logger/issues) with:
- What step failed
- The error message (remove your keys!)
- Your OS (Windows/Mac/Linux)

---

## ⚙️ Advanced Configuration

**Only read this after you have Logan working!**

### Finding your location geonameid for Shabbat times:
- Jerusalem: 281184
- Tel Aviv: 293397
- Haifa: 294801
- Search for other cities at [geonames.org](https://www.geonames.org)

```bash
# Build TypeScript to JavaScript
npm run build

# Start the bot
npm start
```

**You should see:**
```
[INFO] Starting WhatsApp bot...
[INFO] API server listening on port 7700
[INFO] Connecting to WhatsApp...
```

A **QR code will appear** in your terminal.

### Step 5: Link WhatsApp

1. Open WhatsApp on the phone you want to use as the bot
2. Go to **Settings** (⚙️)
3. Tap **Linked Devices**
4. Tap **Link a Device**
5. **Scan the QR code** from the terminal

✅ **Success!** You should see:
```
[INFO] WhatsApp connection established
[INFO] Bot JID: 972501234567@s.whatsapp.net
```

### Step 6: Add Bot to Groups

1. Add the bot's WhatsApp number to any group
2. **Make the bot an admin** (required for locking/unlocking and spam removal)
   - Tap group name > Participants
   - Find bot's number
   - Long press > "Make group admin"

### Step 7: Test the Bot

Send a message in the group:

```
@Logan שלום! מה שלומך?
```

The bot should respond with an AI-generated reply!

**Test other features:**
```bash
# Test daily summary
curl -X POST http://localhost:7700/api/summary/trigger \
  -H "x-api-key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"groupId": "120363..."}'

# Check health
curl http://localhost:7700/api/health \
  -H "x-api-key: your-api-key"

# List groups
curl http://localhost:7700/api/groups \
  -H "x-api-key: your-api-key"
```

---

## ⚙️ Configuration

### Full Environment Variables

See [.env.example](.env.example) for complete documentation of all settings.

### Key Settings

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUPABASE_URL` | ✅ Yes | - | Your Supabase project URL |
| `SUPABASE_KEY` | ✅ Yes | - | Supabase anon/public key |
| `GROQ_API_KEY` | ✅ Yes | - | Groq API for AI responses |
| `ANTHROPIC_API_KEY` | ✅ Yes | - | Claude API for summaries |
| `BOT_PHONE_NUMBER` | ✅ Yes | - | Bot's WhatsApp number (format: 972501234567) |
| `API_KEY` | ⚠️ Recommended | - | API authentication key |
| `API_PORT` | No | 7700 | API server port |
| `ELEVENLABS_API_KEY` | No | - | For voice summaries |
| `DAILY_SUMMARY_ENABLED` | No | true | Enable daily summaries |
| `DAILY_SUMMARY_TIME` | No | 22:00 | Summary time (24h, Israel TZ) |
| `SHABBAT_ENABLED` | No | true | Enable Shabbat auto-lock |
| `SHABBAT_LOCK_OFFSET` | No | -30 | Minutes before candle lighting |
| `SHABBAT_UNLOCK_OFFSET` | No | 30 | Minutes after havdalah |
| `SPAM_DETECTION_ENABLED` | No | true | Enable spam detection |
| `SPAM_WHITELIST` | No | - | Comma-separated exempt numbers |
| `AUTO_PROCESS_JOIN_REQUESTS` | No | true | Auto-approve/reject join requests |
| `JOIN_REQUEST_BOT_THRESHOLD` | No | 3 | Bot suspicion score threshold (0-5) |
| `MAX_GROUP_SIZE` | No | 1024 | Maximum group members |
| `ALLOWED_GROUPS` | No | - | JSON array of groups to monitor (empty = all groups) |
| `AGENT_ADMIN_NUMBERS` | No | - | Comma-separated admin phone numbers |
| `ADMIN_ONLY_MODE` | No | false | Restrict bot to admins only |
| `TAVILY_API_KEY` | No | - | For web search integration |
| `LOG_LEVEL` | No | info | Logging level (info/debug/warn/error) |

### Group Filtering

By default, Logan monitors **ALL groups** it's added to. To restrict to specific groups:

```env
# Monitor only these groups (JSON array)
ALLOWED_GROUPS='[
  {"id":"120363XXXXXXXXXX@g.us","name":"My Group 1"},
  {"id":"120363YYYYYYYYYY@g.us","name":"My Group 2"}
]'
```

**To get a group ID:**
```bash
curl http://localhost:7700/api/groups -H "x-api-key: your-key"
```

### Admin Authorization

Control who can use advanced features (agent, web search, tools):

```env
# Admins can use all features in any group or DM
AGENT_ADMIN_NUMBERS=972501234567,972509876543

# Groups where ALL users can use advanced features
AGENT_PUBLIC_GROUPS=120363XXXXXXXXXX@g.us

# Groups where ALL users can chat with Logan (text only, no tools)
AGENT_FREE_CHAT_GROUPS=120363XXXXXXXXXX@g.us
```

### ADMIN_ONLY_MODE

Restrict Logan to admin-only usage:

```env
ADMIN_ONLY_MODE=true
AGENT_ADMIN_NUMBERS=972501234567
```

When enabled:
- Only users in `AGENT_ADMIN_NUMBERS` can interact with Logan
- Bot ignores all other users in groups and DMs
- Useful for testing or private bot instances

### Advanced: Copilot SDK Agent (Optional)

**Most users should skip this** - it's an advanced feature requiring separate setup.

Copilot SDK Agent integration enables:
- Video generation with Remotion
- MCP server access (Obsidian, Tavily, Atlassian)
- Shell command execution

```env
COPILOT_AGENT_ENABLED=false  # Keep disabled unless you know what this is
COPILOT_AGENT_URL=http://localhost:4001
COPILOT_AGENT_PUBLIC_PATH=/path/to/agent/public
```

See [ADVANCED.md](docs/ADVANCED.md) for Copilot setup (advanced users only).

---

## 🔒 Security

**⚠️ CRITICAL**: This bot handles sensitive data including WhatsApp messages and API credentials.

### Security Checklist

Before deploying:
- [ ] **Never commit `.env`** - Contains all your API keys
- [ ] **Never commit `auth_info/`** - Anyone with this can impersonate your bot
- [ ] **Set strong `API_KEY`** - Generate with `openssl rand -hex 32`
- [ ] **Enable Supabase RLS** - Protect your database with Row Level Security
- [ ] **Run `npm audit`** - Check for vulnerable dependencies
- [ ] **Use HTTPS** - If exposing API publicly
- [ ] **Rotate keys regularly** - Especially if leaked

### What to Protect

| File/Folder | Contains | Risk if Leaked |
|-------------|----------|----------------|
| `.env` | All API keys, database credentials | Full bot takeover, API abuse charges |
| `auth_info/` | WhatsApp session | Anyone can impersonate your bot |
| `shabbat_lock_state.json` | Lock state (safe) | None - just local state |
| `shabbat_times_cache.json` | Cached Shabbat times (safe) | None - just cached data |

### Supabase Row Level Security (RLS)

Protect your database with RLS policies:

```sql
-- Enable RLS
ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_auth_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_guard ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_responses ENABLE ROW LEVEL SECURITY;

-- Allow authenticated access
CREATE POLICY "Authenticated users can read messages"
  ON whatsapp_messages FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Service role full access"
  ON whatsapp_messages FOR ALL
  USING (auth.role() = 'service_role');
```

📖 **See [SECURITY.md](SECURITY.md) for complete security guidelines**, including:
- Incident response procedures
- API key rotation
- GDPR/privacy compliance
- Secure deployment practices

---

## 🌐 API Endpoints

All endpoints require `x-api-key` header when `API_KEY` is configured.

### Health & Status

```bash
# Health check
GET /api/health
Response: { "status": "ok", "connected": true, "timestamp": "..." }

# List monitored groups
GET /api/groups
Response: [{ "id": "120363...", "name": "My Group", "participants": 25 }]

# View message queue
GET /api/queue
Response: { "pending": 3, "processing": 0 }
```

### Messaging

```bash
# Send message to specific group
POST /api/send-message
Body: {
  "groupId": "120363012345678901@g.us",
  "message": "Hello everyone!",
  "mentionNumber": "972501234567"  # Optional
}

# Broadcast to all groups
POST /api/broadcast
Body: { "message": "Important announcement!" }
```

### Daily Summary

```bash
# Trigger immediate summary for a group
POST /api/summary/trigger
Body: { "groupId": "120363012345678901@g.us" }

# Test summary generation (dry run)
GET /api/summary/test/:groupId
```

### Shabbat Control

```bash
# Lock all groups (testing)
GET /api/test-shabbat-lock

# Unlock all groups (testing)
GET /api/test-shabbat-unlock

# Lock specific group
POST /api/group-lock
Body: { "groupId": "120363..." }

# Unlock specific group
POST /api/group-unlock
Body: { "groupId": "120363..." }
```

### Spam Management

```bash
# View whitelist
GET /api/spam/whitelist

# Add number to whitelist
POST /api/spam/whitelist
Body: { "number": "972501234567" }
```

📖 Full API documentation: See source code in [src/api.ts](src/api.ts)

---

## 🏗️ Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         LOGAN BOT                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐     ┌──────────────┐     ┌────────────────┐  │
│  │   WhatsApp   │────▶│   Message    │────▶│   Supabase     │  │
│  │   (Baileys)  │     │   Handler    │     │   (Storage)    │  │
│  └──────────────┘     └──────┬───────┘     └────────────────┘  │
│                              │                                   │
│         ┌────────────────────┼────────────────────┐             │
│         ▼                    ▼                    ▼             │
│  ┌────────────┐      ┌────────────┐      ┌────────────────┐    │
│  │  Mention   │      │   Voice    │      │     Spam       │    │
│  │  Response  │      │  Transcribe│      │   Detection    │    │
│  │   (Groq)   │      │  (Whisper) │      │    (Groq)      │    │
│  └────────────┘      └────────────┘      └────────────────┘    │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    Scheduled Tasks                        │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │  │
│  │  │   Daily     │  │   Shabbat   │  │  Erev Shabbat   │   │  │
│  │  │  Summary    │  │   Locker    │  │    Summary      │   │  │
│  │  │ (22:00 IL)  │  │  (Hebcal)   │  │ (30 min before) │   │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                      Express API                          │  │
│  │  /api/health  /api/send-message  /api/broadcast  ...     │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

External Services:
┌──────────┐  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌────────┐
│  Groq    │  │  Claude  │  │ ElevenLabs│  │  Hebcal  │  │ Tavily │
│  (Chat)  │  │(Summary) │  │   (TTS)   │  │  (Times) │  │(Search)│
└──────────┘  └──────────┘  └───────────┘  └──────────┘  └────────┘
```

### Project Structure

```
whatsapp-logger/
├── src/
│   ├── index.ts              # Entry point, initializes all services
│   ├── api.ts                # Express API server
│   ├── connection.ts         # WhatsApp connection management
│   ├── messageHandler.ts     # Message processing pipeline
│   ├── mentionWebhook.ts     # Mention detection & AI response
│   ├── supabase.ts           # Database operations
│   ├── shabbatLocker.ts      # Shabbat auto-lock/unlock (4-layer detection)
│   ├── broadcastGuard.ts     # Supabase-backed duplicate prevention
│   ├── spamDetector.ts       # Spam detection & removal
│   ├── joinRequestProcessor.ts # Auto-approve/reject join requests
│   ├── config.ts             # Configuration management
│   ├── types.ts              # TypeScript type definitions
│   ├── services/
│   │   ├── groq.ts           # Groq API client
│   │   ├── claude.ts         # Claude API client
│   │   ├── tavily.ts         # Web search with source validation
│   │   ├── whisper.ts        # Voice transcription
│   │   ├── elevenlabs.ts     # Text-to-speech
│   │   └── supabase-auth-state.ts  # Database-backed auth state
│   ├── features/
│   │   ├── daily-summary.ts  # Daily summary generation & scheduling
│   │   ├── mention-response.ts # AI mention responses & voice generation
│   │   └── broadcast.ts      # Group broadcast messaging
│   ├── utils/
│   │   └── botDetection.ts   # Bot detection for join requests
│   └── scripts/
│       └── shavua-tov.ts     # Manual Shavua Tov broadcast script
├── migrations/               # SQL migrations for Supabase
│   ├── 001_create_broadcast_guard.sql
│   ├── 002_add_atomic_lock_index.sql
│   └── 003_create_pending_responses.sql
├── docs/
│   ├── onboarding.md         # Complete setup guide
│   ├── phone-change.md       # Phone number change guide
│   └── SHABBAT_LOCKER.md     # Shabbat lock system documentation
├── auth_info/                # WhatsApp session (gitignored!)
├── .env.example              # Environment template
├── .env                      # Your config (gitignored!)
├── package.json
├── tsconfig.json
├── LICENSE
├── SECURITY.md               # Security guidelines
└── PRE_OPEN_SOURCE_CHECKLIST.md  # Open-source preparation
```

### Key Components

| Component | Purpose | Tech Stack |
|-----------|---------|------------|
| **Baileys** | WhatsApp Web API | WebSocket connection to WhatsApp |
| **Supabase** | Database & auth state | PostgreSQL with real-time |
| **Groq** | AI responses & spam detection | LLaMA 3.3 70B / GPT-4 class |
| **Claude** | Daily summaries | Claude 3.5 Sonnet |
| **Whisper** | Voice transcription | Groq's Whisper endpoint |
| **ElevenLabs** | Voice synthesis | Neural TTS |
| **Hebcal** | Shabbat times | Jewish calendar API |
| **Tavily** | Web search | Real-time search with citations |

---

## 🔧 Troubleshooting

### Bot Not Responding to Mentions

**Symptoms**: Bot ignores @mentions in groups

**Solutions**:
1. Verify `BOT_PHONE_NUMBER` in `.env` matches your number exactly (format: 972501234567, no + or dashes)
2. Check logs for "Bot JID" - should match your number
3. Ensure bot is actually in the group
4. Try @mentioning with the exact contact name saved in your phone

### Daily Summary Not Sending

**Symptoms**: No summary at scheduled time

**Solutions**:
1. Check `DAILY_SUMMARY_ENABLED=true` in `.env`
2. Verify `ANTHROPIC_API_KEY` is valid (test at console.anthropic.com)
3. Check bot logs at scheduled time (default 22:00 Israel time)
4. Test manually: `curl -X POST http://localhost:7700/api/summary/trigger -H "x-api-key: your-key"`
5. Ensure bot has sent at least a few messages in the group (needs context)

### Shabbat Lock Not Working

**Symptoms**: Groups not locking before Shabbat

**Solutions**:
1. Verify `SHABBAT_ENABLED=true` in `.env`
2. **Bot MUST be admin** in the group (required to change settings)
3. Check `SHABBAT_LOCK_LOCATION` is set to correct geonameid
4. Test manually: `curl http://localhost:7700/api/test-shabbat-lock -H "x-api-key: your-key"`
5. Check logs for "Shabbat lock" messages

### Connection Issues (440 Errors)

**Symptoms**: Bot keeps disconnecting, shows "Session replaced" or error 440

**Solutions**:
1. **Close ALL other WhatsApp Web sessions** - Most common cause!
   - Open WhatsApp on phone > Linked Devices
   - Log out all other sessions
2. Check for duplicate bot instances running:
   ```bash
   # Windows
   tasklist | findstr node
   # Kill extra instances

   # Linux/Mac
   ps aux | grep node
   kill <pid>
   ```
3. Delete `auth_info/` and re-scan QR code (fresh session)
4. Wait 5-10 minutes if rate limited (bot uses exponential backoff)
5. Ensure stable internet connection

### Voice Messages Not Transcribing

**Symptoms**: Voice messages don't get transcribed

**Solutions**:
1. Check `GROQ_API_KEY` is valid
2. Verify Groq daily quota (200K tokens/day on free tier)
3. Check logs for "Whisper" errors
4. Voice file might be corrupted - ask sender to resend

### Spam Detection False Positives

**Symptoms**: Legitimate users getting flagged as spam

**Solutions**:
1. Add them to whitelist: `SPAM_WHITELIST=972501234567,972509876543`
2. Review spam logs to understand why they were flagged
3. Adjust spam detection prompt in `src/spamDetector.ts` if needed
4. Temporarily disable: `SPAM_DETECTION_ENABLED=false`

### Database Errors

**Symptoms**: Errors about Supabase or database connection

**Solutions**:
1. Verify `SUPABASE_URL` and `SUPABASE_KEY` are correct
2. Check Supabase dashboard - project might be paused (free tier after 1 week inactivity)
3. Run migrations if tables don't exist (see Setup Step 1)
4. Check Supabase logs in dashboard for specific errors

### API Key Invalid

**Symptoms**: 401 Unauthorized errors from APIs

**Solutions**:
1. Verify each API key in respective console:
   - Groq: console.groq.com
   - Anthropic: console.anthropic.com
   - ElevenLabs: elevenlabs.io
2. Check for extra spaces in `.env` file
3. Ensure keys haven't expired or been revoked
4. Regenerate keys if needed

### Memory/Performance Issues

**Symptoms**: Bot using too much RAM or CPU

**Solutions**:
1. Increase Node.js memory limit:
   ```bash
   node --max-old-space-size=4096 dist/index.js
   ```
2. Reduce context window: Lower message history limits in code
3. Clear old messages from database periodically
4. Monitor with `pm2 monit` if using PM2

### Can't Find Group ID

**Symptoms**: Need group ID for API calls

**Solutions**:
```bash
# List all groups with IDs
curl http://localhost:7700/api/groups -H "x-api-key: your-key"

# Or check logs when bot receives a message - group ID is logged
```

---

## 🚀 Production Deployment

### Using PM2 (Recommended)

PM2 keeps your bot running 24/7 with auto-restart on crashes:

```bash
# Install PM2 globally
npm install -g pm2

# Build the project
npm run build

# Start with PM2
pm2 start dist/index.js --name logan

# Save PM2 config
pm2 save

# Enable auto-start on system boot
pm2 startup
# Follow the instructions printed

# Monitor
pm2 monit           # Real-time monitoring
pm2 logs logan      # View logs
pm2 restart logan   # Restart bot
pm2 stop logan      # Stop bot
```

### Using Docker (Alternative)

```dockerfile
# Dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build

CMD ["node", "dist/index.js"]
```

```bash
# Build and run
docker build -t logan-bot .
docker run -d \
  --name logan \
  --env-file .env \
  -v $(pwd)/auth_info:/app/auth_info \
  -p 7700:7700 \
  logan-bot
```

### Monitoring

```bash
# Health check endpoint
curl http://localhost:7700/api/health

# Check logs
pm2 logs logan

# Check system resources
pm2 monit

# Restart if needed
pm2 restart logan
```

---

## 📖 Documentation

- **[Onboarding Guide](docs/onboarding.md)** - Complete step-by-step setup
- **[Phone Change Guide](docs/phone-change.md)** - How to change bot's WhatsApp number
- **[Shabbat Lock System](docs/SHABBAT_LOCKER.md)** - Technical details of Shabbat protection
- **[Security Guidelines](SECURITY.md)** - Security best practices & incident response
- **[Open Source Prep](PRE_OPEN_SOURCE_CHECKLIST.md)** - Checklist before going public
- **[Environment Variables](.env.example)** - Complete configuration reference

---

## 🤝 Contributing

Contributions are welcome! Here's how:

### Reporting Issues

1. Check existing issues first
2. Provide:
   - Logan version (`package.json`)
   - Node.js version (`node --version`)
   - Error logs (redact sensitive info!)
   - Steps to reproduce

### Submitting Code

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make changes and test thoroughly
4. Commit with clear messages:
   ```bash
   git commit -m "feat: Add voice summary cooldown"
   git commit -m "fix: Handle 440 errors with exponential backoff"
   ```
5. Push and create a Pull Request

### Development Setup

```bash
# Clone your fork
git clone https://github.com/yourusername/whatsapp-logger.git

# Install dependencies
npm install

# Run in development mode (hot reload)
npm run dev

# Run tests (if available)
npm test

# Build for production
npm run build
```

### Code Style

- Use TypeScript for all new code
- Follow existing code style
- Add comments for complex logic
- Update documentation if changing behavior

---

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

Copyright (c) 2024-2026 **Yuval Avidani** ([@hoodini](https://github.com/hoodini))

This means you can:
- ✅ Use commercially
- ✅ Modify
- ✅ Distribute
- ✅ Private use

You must:
- 📝 Include license and copyright notice
- 📝 State changes made
- 📝 Attribute to original author

---

## 👨‍💻 Author

**Yuval Avidani** - AI Speaker & Builder

<p>
  <img src="https://img.shields.io/badge/2x%20GitHub%20Star-%E2%AD%90%E2%AD%90-yellow" alt="2x GitHub Star"/>
  <img src="https://img.shields.io/badge/2x%20AWS%20Gen%20AI%20Superstar-%F0%9F%8C%9F%F0%9F%8C%9F-orange" alt="2x AWS Gen AI Superstar"/>
</p>

**Connect with me:**
- 🌐 Website: [yuv.ai](https://yuv.ai)
- 🐙 GitHub: [@hoodini](https://github.com/hoodini)
- 🐦 Twitter/X: [@yuvalav](https://twitter.com/yuvalav)
- 📸 Instagram: [@yuval_770](https://instagram.com/yuval_770)
- 🎥 YouTube: [@yuv-ai](https://youtube.com/@yuv-ai)
- 🔗 Linktree: [linktr.ee/yuvai](https://linktr.ee/yuvai)

**About:**
Yuval is a 2x GitHub Star and 2x AWS Gen AI Superstar, passionate about building AI-powered tools for communities. Logan is a passion project built with love and released to the open-source community to help others create intelligent WhatsApp bots.

> *"Building AI tools that make a real difference in people's daily lives."* - Yuval Avidani

---

## 🙏 Acknowledgments

### Technology Stack

Built with these amazing open-source projects:

- **[Baileys](https://github.com/WhiskeySockets/Baileys)** - WhatsApp Web API by [@WhiskeySockets](https://github.com/WhiskeySockets)
- **[Supabase](https://supabase.com)** - Open source Firebase alternative
- **[Anthropic Claude](https://anthropic.com)** - Advanced AI for daily summaries
- **[Groq](https://groq.com)** - Lightning-fast LLM inference
- **[ElevenLabs](https://elevenlabs.io)** - Realistic voice synthesis
- **[Hebcal](https://www.hebcal.com)** - Jewish calendar API
- **[Tavily](https://tavily.com)** - AI-optimized search API
- **[Node.js](https://nodejs.org)** - JavaScript runtime
- **[TypeScript](https://www.typescriptlang.org)** - Type-safe JavaScript
- **[Express](https://expressjs.com)** - Web framework
- **[Pino](https://getpino.io)** - Fast logging

### Special Thanks

- The Israeli tech community for inspiration and feedback
- Early testers who helped refine Logan's features
- The open-source community for making projects like this possible

---

## 💬 Community & Support

- **Issues**: [GitHub Issues](https://github.com/hoodini/whatsapp-logger/issues)
- **Discussions**: [GitHub Discussions](https://github.com/hoodini/whatsapp-logger/discussions)
- **Security**: See [SECURITY.md](SECURITY.md) for reporting vulnerabilities
- **Questions**: Open a discussion or reach out to [@hoodini](https://github.com/hoodini)

### Contributing

Contributions are welcome! See [Contributing](#-contributing) section above for guidelines.

If Logan helped you, consider:
- ⭐ Starring this repo
- 🐛 Reporting bugs
- 💡 Suggesting features
- 📝 Improving documentation
- 🔧 Submitting pull requests

---

## ⚖️ Disclaimer

This is an **unofficial, community-maintained project** not affiliated with or endorsed by WhatsApp, Meta, Facebook, or any official Logan project. Use at your own risk.

**Important**:
- Using WhatsApp bots may violate WhatsApp's Terms of Service
- Your account could be banned if detected
- This software is provided "as is" without warranty
- The author is not responsible for any consequences of using this software

**Privacy Notice**:
- This bot logs all messages from groups it's added to
- Ensure compliance with local privacy laws (GDPR, CCPA, etc.)
- Inform group members about logging
- Provide opt-out mechanisms if required by law
- You are responsible for data protection and privacy compliance

**Ethical Use**:
- Only use Logan in groups where all members are aware and consent
- Respect privacy and data protection laws
- Do not use for spam, harassment, or malicious purposes
- Be transparent about bot presence and capabilities

---

<p align="center">
  <b>Built with ❤️ for the open source community by <a href="https://github.com/hoodini">Yuval Avidani</a></b>
</p>

<p align="center">
  <a href="https://yuv.ai">🌐 Website</a> •
  <a href="https://github.com/hoodini">🐙 GitHub</a> •
  <a href="https://twitter.com/yuvalav">🐦 Twitter</a> •
  <a href="https://youtube.com/@yuv-ai">🎥 YouTube</a>
</p>

<p align="center">
  <a href="#-table-of-contents">Back to Top ↑</a>
</p>

---

<p align="center">
  <i>If Logan helped you, consider starring ⭐ this repo and sharing it with others!</i>
</p>
