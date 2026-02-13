/**
 * Agent Trigger Detection
 *
 * Determines when to route messages to the Copilot SDK Agent
 * vs handling them with the standard Groq API
 *
 * USAGE:
 *   @Logan מה נשמע?              → Groq (fast, default)
 *   @Logan צור וידאו של חתול      → Agent (auto-detected video)
 *   @Logan >> check my obsidian  → Agent (explicit prefix)
 *   @Logan ! dir                 → Direct shell command (no AI)
 */

// Authorized admins who can use agent features and text triggers everywhere
// Configured via AGENT_ADMIN_NUMBERS environment variable (comma-separated)
const AUTHORIZED_ADMINS = new Set(
  (process.env.AGENT_ADMIN_NUMBERS || '').split(',').map(n => n.trim()).filter(n => n)
);

// Groups where ALL users can use agent features (video, tools, etc.)
// Configured via AGENT_PUBLIC_GROUPS environment variable (comma-separated)
const PUBLIC_AGENT_GROUPS = new Set(
  (process.env.AGENT_PUBLIC_GROUPS || '').split(',').map(g => g.trim()).filter(g => g)
);

// Groups where ALL USERS can trigger Logan with text mentions of "logan" or "לוגן"
// Note: Admins can use text triggers in ANY group (see isAdminTextTriggerAllowed)
// IMPORTANT: Being in FREE_CHAT_GROUPS only allows TEXT chat with Logan
// Tool usage (video, landing pages, web search) requires admin OR being in PUBLIC_AGENT_GROUPS
// Configured via AGENT_FREE_CHAT_GROUPS environment variable (comma-separated)
const FREE_CHAT_GROUPS = new Set(
  (process.env.AGENT_FREE_CHAT_GROUPS || '').split(',').map(g => g.trim()).filter(g => g)
);

/**
 * Check if a sender is an authorized admin
 * Admins can use text triggers ("לוגן", "logan") in ANY group or DM
 */
export function isAuthorizedAdmin(senderNumber: string): boolean {
  const normalized = senderNumber.replace(/[^0-9]/g, '');
  return AUTHORIZED_ADMINS.has(normalized);
}

/**
 * Check if text trigger is allowed for this sender in this chat
 * Returns true if:
 * - Sender is admin (can use text triggers EVERYWHERE)
 * - Chat is in FREE_CHAT_GROUPS (any user can use text triggers)
 * - Chat is a DM (always allow text triggers for admin)
 */
export function isTextTriggerAllowed(chatId: string, senderNumber: string): boolean {
  // Admin can use text triggers EVERYWHERE
  if (isAuthorizedAdmin(senderNumber)) {
    return true;
  }
  // Anyone can use text triggers in FREE_CHAT_GROUPS
  if (FREE_CHAT_GROUPS.has(chatId)) {
    return true;
  }
  return false;
}

/**
 * Patterns to detect "Logan" being called in voice messages
 * Since you can't @mention in voice, users say "Logan" to trigger
 */
const LOGAN_VOICE_TRIGGERS = [
  /^לוגן/i,           // Hebrew: starts with לוגן
  /^לוגאן/i,          // Hebrew: starts with לוגאן (with א)
  /^logan/i,          // English: starts with Logan
  /היי\s*לוג[אֹ]?ן/i,  // Hebrew: "היי לוגן/לוגאן" (hey Logan)
  /הי\s*לוג[אֹ]?ן/i,   // Hebrew: "הי לוגן/לוגאן" (hi Logan)
  /שלום\s*לוג[אֹ]?ן/i, // Hebrew: "שלום לוגן/לוגאן" (hello Logan)
];

/**
 * Patterns that trigger landing page generation via Logan
 * These patterns detect when users want to create websites or landing pages
 */
const LANDING_PAGE_TRIGGERS = [
  // Hebrew - landing page (flexible patterns that allow words in between)
  /צור\s+.*(דף|עמוד)\s*נחיתה/i,     // "צור לי דף נחיתה", "צור לי דף נחיתה מדהים"
  /תצור\s+.*(דף|עמוד)\s*נחיתה/i,    // "תצור לי דף נחיתה"
  /עשה\s+.*(דף|עמוד)\s*נחיתה/i,     // "עשה לי דף נחיתה"
  /תעשה\s+.*(דף|עמוד)\s*נחיתה/i,    // "תעשה לי דף נחיתה"
  /הכן\s+.*(דף|עמוד)\s*נחיתה/i,     // "הכן לי דף נחיתה"
  /בנה\s+.*(דף|עמוד)\s*נחיתה/i,     // "בנה לי דף נחיתה"
  /תבנה\s+.*(דף|עמוד)\s*נחיתה/i,    // "תבנה לי דף נחיתה"
  // Hebrew - website (flexible patterns)
  /צור\s+.*אתר/i,                    // "צור לי אתר", "צור לי אתר מגניב"
  /תצור\s+.*אתר/i,                   // "תצור לי אתר"
  /עשה\s+.*אתר/i,                    // "עשה לי אתר"
  /תעשה\s+.*אתר/i,                   // "תעשה לי אתר"
  /בנה\s+.*אתר/i,                    // "בנה לי אתר"
  /תבנה\s+.*אתר/i,                   // "תבנה לי אתר"
  // Hebrew - standalone patterns
  /(דף|עמוד)\s*נחיתה\s*(ל|בשביל|עבור)/i,  // "דף נחיתה ל..."
  // English - landing page (flexible patterns that allow words between action and "landing page")
  /create\s+.*landing\s*page/i,    // "create a landing page", "create an EPIC landing page"
  /make\s+.*landing\s*page/i,      // "make a landing page", "make me a landing page"
  /build\s+.*landing\s*page/i,     // "build a landing page", "build an awesome landing page"
  /generate\s+.*landing\s*page/i,  // "generate a landing page"
  // English - website (flexible patterns)
  /create\s+.*website/i,           // "create a website", "create an amazing website"
  /make\s+.*website/i,             // "make a website"
  /build\s+.*website/i,            // "build a website"
  /generate\s+.*website/i,         // "generate a website"
  /create\s+.*webpage/i,           // "create a webpage"
  /make\s+.*webpage/i,             // "make a webpage"
  /build\s+.*webpage/i,            // "build a webpage"
  // English - web experience / digital experience (creative descriptions)
  /create\s+.*web\s*experience/i,      // "create a web experience", "create an ultra-premium web experience"
  /make\s+.*web\s*experience/i,        // "make a web experience"
  /build\s+.*web\s*experience/i,       // "build a web experience"
  /create\s+.*digital\s*experience/i,  // "create a digital experience"
  /make\s+.*digital\s*experience/i,    // "make a digital experience"
  /build\s+.*digital\s*experience/i,   // "build a digital experience"
  // English - site (with word boundary)
  /create\s+.*\bsite\b/i,          // "create a site", "create an awesome site"
  /make\s+.*\bsite\b/i,            // "make a site"
  /build\s+.*\bsite\b/i,           // "build a site"
  // English - web app
  /create\s+.*web\s*app/i,         // "create a web app"
  /make\s+.*web\s*app/i,           // "make a web app"
  /build\s+.*web\s*app/i,          // "build a web app"
  // English - standalone patterns
  /landing\s*page\s*(for|about)/i, // "landing page for..."
  // Update/Edit existing pages
  /עדכן\s*(את\s*)?(ה)?(דף|אתר|עמוד)/i,    // "עדכן את הדף"
  /update\s*(the\s*)?(landing\s*page|website|site|page)/i,
  /edit\s*(the\s*)?(landing\s*page|website|site|page)/i,
];

/**
 * Patterns that trigger video generation via Remotion
 * Patterns are flexible to allow words between "create" and "video"
 * e.g., "create an announcement video" or "make a cool video"
 */
const VIDEO_TRIGGERS = [
  // Hebrew
  /צור\s*וידאו/i,
  /עשה\s*וידאו/i,
  /תעשה\s*וידאו/i,
  /הכן\s*וידאו/i,
  /סרטון/i,
  /אנימציה/i,
  /רמוטיון/i,
  // English - flexible patterns that allow words between action and "video"
  /create\s+.*video/i,      // "create a video", "create an announcement video"
  /make\s+.*video/i,        // "make a video", "make a cool video"
  /generate\s+.*video/i,    // "generate a video", "generate an intro video"
  /render\s+.*video/i,      // "render a video", "render the intro video"
  /remotion/i,
  /video\s*template/i,
  // Template names as triggers
  /announcement\s*video/i,
  /tiktok\s*caption/i,
  /code\s*highlight/i,
  /branded\s*intro/i,
  /text\s*animation/i,
  /gradient\s*text/i,
];

export interface TriggerResult {
  shouldUseAgent: boolean;
  isVideoRequest: boolean;
  isLandingPageRequest: boolean;
  isDirectCommand: boolean;
  extractedCommand?: string;
  triggerType: 'video' | 'landing_page' | 'agent' | 'direct' | 'groq';
}

/**
 * Check if message should be routed to Copilot Agent
 *
 * Routing rules:
 * 1. `>> prompt` → Send to agent (explicit)
 * 2. `! command` → Direct shell execution (no AI)
 * 3. Video keywords → Send to agent for video generation
 * 4. Everything else → Groq (fast chat)
 *
 * Authorization:
 * - Admins (configured via AGENT_ADMIN_NUMBERS) can use agent features in ANY group
 * - All users in public agent groups (configured via AGENT_PUBLIC_GROUPS) can use agent features
 */
export function shouldRouteToAgent(
  message: string,
  senderNumber: string,
  groupId?: string
): TriggerResult {
  const trimmedMessage = message.trim();

  // Normalize sender number (remove @s.whatsapp.net suffix if present)
  const normalizedSender = senderNumber.replace(/@s\.whatsapp\.net$/, '');

  // Debug logging to help troubleshoot sender format issues
  console.log(`[AGENT-TRIGGER] Checking authorization:`);
  console.log(`[AGENT-TRIGGER]   Raw sender: "${senderNumber}"`);
  console.log(`[AGENT-TRIGGER]   Normalized: "${normalizedSender}"`);
  console.log(`[AGENT-TRIGGER]   Group ID: "${groupId || 'N/A'}"`);
  console.log(`[AGENT-TRIGGER]   Authorized admins: [${Array.from(AUTHORIZED_ADMINS).join(', ')}]`);

  // Check authorization: admin OR anyone in public agent groups
  const isAdmin = AUTHORIZED_ADMINS.has(normalizedSender);
  const isInPublicAgentGroup = groupId ? PUBLIC_AGENT_GROUPS.has(groupId) : false;
  const isAuthorized = isAdmin || isInPublicAgentGroup;

  console.log(`[AGENT-TRIGGER]   Is admin: ${isAdmin}, In public group: ${isInPublicAgentGroup}, Authorized: ${isAuthorized}`);

  if (!isAuthorized) {
    console.log(`[AGENT-TRIGGER] Not authorized for agent features`);
    return {
      shouldUseAgent: false,
      isVideoRequest: false,
      isLandingPageRequest: false,
      isDirectCommand: false,
      triggerType: 'groq'
    };
  }

  // 1. Check for direct shell command: ! command
  if (trimmedMessage.startsWith('!')) {
    const command = trimmedMessage.slice(1).trim();
    if (command) {
      return {
        shouldUseAgent: true,
        isVideoRequest: false,
        isLandingPageRequest: false,
        isDirectCommand: true,
        extractedCommand: command,
        triggerType: 'direct'
      };
    }
  }

  // 2. Check for explicit agent prefix: >> prompt
  if (trimmedMessage.startsWith('>>')) {
    const prompt = trimmedMessage.slice(2).trim();
    return {
      shouldUseAgent: true,
      isVideoRequest: false,
      isLandingPageRequest: false,
      isDirectCommand: false,
      extractedCommand: prompt || trimmedMessage,
      triggerType: 'agent'
    };
  }

  // 3. Check for landing page generation triggers (auto-detected)
  // This is checked BEFORE video triggers because landing pages take longer
  for (const pattern of LANDING_PAGE_TRIGGERS) {
    if (pattern.test(trimmedMessage)) {
      return {
        shouldUseAgent: true,
        isVideoRequest: false,
        isLandingPageRequest: true,
        isDirectCommand: false,
        triggerType: 'landing_page'
      };
    }
  }

  // 4. Check for video generation triggers (auto-detected)
  for (const pattern of VIDEO_TRIGGERS) {
    if (pattern.test(trimmedMessage)) {
      return {
        shouldUseAgent: true,
        isVideoRequest: true,
        isLandingPageRequest: false,
        isDirectCommand: false,
        triggerType: 'video'
      };
    }
  }

  // 5. Default: use Groq for fast chat
  return {
    shouldUseAgent: false,
    isVideoRequest: false,
    isLandingPageRequest: false,
    isDirectCommand: false,
    triggerType: 'groq'
  };
}

/**
 * Build a prompt for video generation
 * Encourages the agent to be a creative director, not just a template filler
 */
export function buildVideoPrompt(userMessage: string): string {
  return `🎬 VIDEO DIRECTOR MODE

User's creative brief: "${userMessage}"

YOU ARE A CREATIVE DIRECTOR. Your job is to create a STUNNING video, not just fill in template props.

## YOUR AVAILABLE TOOLS (use them!):

### Image Generation:
- **generate_image** - Nano Banana Pro (Gemini 3 Pro Image)
  - Use for: backgrounds, illustrations, visual concepts
  - Supports aspect ratios: 16:9, 1:1, 9:16
  - Creates stunning AI-generated visuals

### Web Search (via MCP):
- **call_mcp_tool** with serverName: "tavily" - Research topics, find inspiration
- **web_fetch** - Fetch content from specific URLs

### Video Generation:
- **generate_video** - Create videos with Remotion templates
  - Remotion supports Lottie animations via @remotion/lottie
  - Can include Lottie JSON URLs in custom compositions

## YOUR CREATIVE PROCESS:

1. **RESEARCH** (use call_mcp_tool with tavily)
   - Search for visual inspiration related to the topic
   - Understand the emotional tone and message

2. **CREATE VISUALS** (use generate_image)
   - Generate 2-4 custom images that tell the story
   - Think about what visuals will make this memorable

3. **BUILD THE VIDEO** (use generate_video)
   - Use Slideshow template with your generated images, OR
   - Use HypeVideo/UltraHype/KineticShowcase for viral impact

## Available Remotion Templates:

| Template        | Best For                                         |
|----------------|--------------------------------------------------|
| TextAnimation  | Impactful text reveals with animation effects    |
| GradientText   | Eye-catching headlines with gradient colors      |
| Quote          | Inspirational quotes with attribution            |
| TikTokCaptions | Word-by-word caption reveals (TikTok style)      |
| SocialPost     | Social media style content (1080x1080)           |
| Announcement   | News/announcement videos with CTA                |
| Countdown      | Countdowns with labels                           |
| Slideshow      | Image slideshows with transitions                |
| CodeHighlight  | Animated code with syntax highlighting           |
| BrandedIntro   | YUV.AI branded intro/outro videos                |
| HypeVideo      | VIRAL style with particles and effects           |
| UltraHype      | EXTREME effects (RGB split, glitch, strobe)      |
| StoryShowcase  | Instagram Story format (1080x1920 vertical)      |
| KineticShowcase| EXPLOSIVE kinetic text with massive fonts        |

## Template Props Reference:
- TextAnimation: text, animation (fadeIn/scaleUp/slideUp/typewriter/bounce), textColor, backgroundColor
- GradientText: text, subtitle, gradientFrom, gradientTo
- Quote: quote, author, accentColor
- TikTokCaptions: words (array), wordsPerPage, highlightColor
- SocialPost: headline, body, accentColor
- Announcement: title, subtitle, ctaText, primaryColor
- Countdown: startNumber, endNumber, label
- Slideshow: images (array of URLs!), transitionDuration, slideDuration
- CodeHighlight: code, language, animation, theme (dark/dracula/monokai/github), showWatermark
- BrandedIntro: title, subtitle, variant (intro/outro/minimal), showProfile, primaryColor

## WORKFLOW EXAMPLE for "things inside an ADHD brain":

1. **call_mcp_tool** (tavily search): "ADHD brain visualization ideas"
2. **generate_image** (x3-4):
   - "Abstract colorful thought bubbles exploding from a brain, neon colors"
   - "Browser with 47 open tabs, chaotic but beautiful"
   - "Scattered sticky notes everywhere, vibrant colors"
   - "Clock melting surrealist style, time blindness concept"
3. **generate_video** with Slideshow template using those image URLs
   - OR use KineticShowcase with impactful text about ADHD

## REMEMBER:
- **generate_image** creates images → use the returned URLs in Slideshow
- **call_mcp_tool** with tavily gives you research/inspiration
- **generate_video** with HypeVideo/UltraHype/KineticShowcase = VIRAL content
- Don't just use basic TextAnimation - CREATE something visually rich!

Now, be the creative director. Make something STUNNING!`;
}

/**
 * Build a prompt for landing page generation
 * Provides context about the landing page generator capabilities
 */
export function buildLandingPagePrompt(userMessage: string): string {
  return `CRITICAL: You MUST use the generate_landing_page tool. DO NOT generate HTML code yourself.

User request: "${userMessage}"

MANDATORY INSTRUCTIONS:
1. Call the generate_landing_page tool with a prompt describing the business
2. DO NOT write any HTML, CSS, or code yourself
3. DO NOT suggest code snippets
4. The tool will generate, deploy, and return a live URL

Example tool call:
generate_landing_page({ "prompt": "סטודיו ליוגה בשם יוגה בשקט בתל אביב, מתמחה במדיטציה ויוגה למקצוענים עסוקים" })

The tool handles EVERYTHING:
- Premium React landing page with 3D effects
- Remotion hero video generation
- Automatic deployment to Cloudflare Pages
- Custom subdomain: {business-name}.yuv.ai

After calling the tool, forward its response directly to the user. The response includes the live URL.

REMEMBER: Your ONLY job is to call generate_landing_page with the business details. Nothing else.`;
}

/**
 * Extract landing page description from user message
 */
export function extractLandingPageDescription(message: string): string {
  // Remove common trigger phrases to get the actual description
  let description = message
    // Hebrew - landing page
    .replace(/צור\s*(לי\s*)?(דף|עמוד)\s*נחיתה\s*(ל|בשביל|עבור|של)?/gi, '')
    .replace(/תצור\s*(לי\s*)?(דף|עמוד)\s*נחיתה\s*(ל|בשביל|עבור|של)?/gi, '')
    .replace(/עשה\s*(לי\s*)?(דף|עמוד)\s*נחיתה\s*(ל|בשביל|עבור|של)?/gi, '')
    .replace(/תעשה\s*(לי\s*)?(דף|עמוד)\s*נחיתה\s*(ל|בשביל|עבור|של)?/gi, '')
    .replace(/הכן\s*(לי\s*)?(דף|עמוד)\s*נחיתה\s*(ל|בשביל|עבור|של)?/gi, '')
    .replace(/בנה\s*(לי\s*)?(דף|עמוד)\s*נחיתה\s*(ל|בשביל|עבור|של)?/gi, '')
    .replace(/תבנה\s*(לי\s*)?(דף|עמוד)\s*נחיתה\s*(ל|בשביל|עבור|של)?/gi, '')
    // Hebrew - website
    .replace(/צור\s*(לי\s*)?אתר\s*(ל|בשביל|עבור|של)?/gi, '')
    .replace(/תצור\s*(לי\s*)?אתר\s*(ל|בשביל|עבור|של)?/gi, '')
    .replace(/עשה\s*(לי\s*)?אתר\s*(ל|בשביל|עבור|של)?/gi, '')
    .replace(/תעשה\s*(לי\s*)?אתר\s*(ל|בשביל|עבור|של)?/gi, '')
    .replace(/בנה\s*(לי\s*)?אתר\s*(ל|בשביל|עבור|של)?/gi, '')
    .replace(/תבנה\s*(לי\s*)?אתר\s*(ל|בשביל|עבור|של)?/gi, '')
    // Hebrew - update
    .replace(/עדכן\s*(את\s*)?(ה)?(דף|אתר|עמוד)\s*(של)?/gi, '')
    // English
    .replace(/create\s*(a\s*)?(landing\s*page|webpage|website|site)\s*(for|about)?/gi, '')
    .replace(/make\s*(a\s*)?(landing\s*page|webpage|website|site)\s*(for|about)?/gi, '')
    .replace(/build\s*(a\s*)?(landing\s*page|webpage|website|site)\s*(for|about)?/gi, '')
    .replace(/generate\s*(a\s*)?(landing\s*page|webpage|website|site)\s*(for|about)?/gi, '')
    .replace(/update\s*(the\s*)?(landing\s*page|website|site|page)\s*(for|about)?/gi, '')
    .replace(/edit\s*(the\s*)?(landing\s*page|website|site|page)\s*(for|about)?/gi, '')
    .trim();

  return description || 'a professional business landing page';
}

/**
 * Extract video description from user message
 */
export function extractVideoDescription(message: string): string {
  // Remove common trigger phrases to get the actual description
  let description = message
    .replace(/צור\s*וידאו\s*(של|עם|ש)?/gi, '')
    .replace(/עשה\s*וידאו\s*(של|עם|ש)?/gi, '')
    .replace(/תעשה\s*וידאו\s*(של|עם|ש)?/gi, '')
    .replace(/הכן\s*וידאו\s*(של|עם|ש)?/gi, '')
    .replace(/create\s*(a\s*)?video\s*(of|with|about)?/gi, '')
    .replace(/make\s*(a\s*)?video\s*(of|with|about)?/gi, '')
    .replace(/generate\s*(a\s*)?video\s*(of|with|about)?/gi, '')
    .replace(/render\s*(a\s*)?video\s*(of|with|about)?/gi, '')
    .trim();

  return description || 'a short animated video';
}

/**
 * Check if a user is authorized for voice processing in a group
 * This allows voice messages to be processed even without @mention
 *
 * Authorization rules:
 * - Admin can use voice in any group
 * - Anyone in the brain emoji group can use voice
 * - DMs are always allowed (handled separately)
 */
export function isAuthorizedForVoice(senderNumber: string, groupId?: string): boolean {
  // Normalize sender number
  const normalizedSender = senderNumber.replace(/@s\.whatsapp\.net$/, '');

  // Admins are always authorized
  if (AUTHORIZED_ADMINS.has(normalizedSender)) {
    return true;
  }

  // Anyone in public agent groups is authorized
  if (groupId && PUBLIC_AGENT_GROUPS.has(groupId)) {
    return true;
  }

  return false;
}

/**
 * Check if the transcription contains a Logan trigger
 * Users say "Logan" in voice messages to trigger the bot
 * since they can't @mention in voice recordings
 */
export function containsLoganTrigger(transcription: string): boolean {
  const trimmed = transcription.trim();
  return LOGAN_VOICE_TRIGGERS.some(pattern => pattern.test(trimmed));
}

/**
 * Remove the Logan trigger from transcription to get the actual query
 * e.g., "לוגן צור וידאו" → "צור וידאו"
 */
export function removeLoganTrigger(transcription: string): string {
  let cleaned = transcription.trim();

  // Remove Hebrew triggers (both לוגן and לוגאן)
  cleaned = cleaned.replace(/^לוגאן[,\s]*/i, '');
  cleaned = cleaned.replace(/^לוגן[,\s]*/i, '');
  cleaned = cleaned.replace(/^היי\s*לוג[אֹ]?ן[,\s]*/i, '');
  cleaned = cleaned.replace(/^הי\s*לוג[אֹ]?ן[,\s]*/i, '');
  cleaned = cleaned.replace(/^שלום\s*לוג[אֹ]?ן[,\s]*/i, '');

  // Remove English triggers
  cleaned = cleaned.replace(/^logan[,\s]*/i, '');
  cleaned = cleaned.replace(/^hey\s*logan[,\s]*/i, '');
  cleaned = cleaned.replace(/^hi\s*logan[,\s]*/i, '');
  cleaned = cleaned.replace(/^hello\s*logan[,\s]*/i, '');

  return cleaned.trim();
}

/**
 * Check if a group is in "free chat" mode where Logan responds to text mentions
 * of "logan" or "לוגן" anywhere in the message
 */
export function isFreeChatGroup(groupId: string): boolean {
  return FREE_CHAT_GROUPS.has(groupId);
}

/**
 * Check if a text message contains a Logan trigger anywhere in the message
 * Used for "free chat" groups where Logan responds to casual mentions
 * More permissive than voice triggers - matches anywhere in message
 */
export function containsLoganTextTrigger(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  // Check for "logan", "לוגן", or "לוגאן" anywhere in the message
  return lowerMessage.includes('logan') || message.includes('לוגן') || message.includes('לוגאן');
}

/**
 * Remove Logan name from text message to get the actual query
 * e.g., "logan מה אתה חושב?" → "מה אתה חושב?"
 */
export function removeLoganFromText(message: string): string {
  let cleaned = message.trim();

  // Remove Hebrew variations (לוגן and לוגאן)
  cleaned = cleaned.replace(/לוגאן[,\s]*/gi, '');
  cleaned = cleaned.replace(/לוגן[,\s]*/gi, '');

  // Remove English variations (case insensitive)
  cleaned = cleaned.replace(/logan[,\s]*/gi, '');

  return cleaned.trim();
}
