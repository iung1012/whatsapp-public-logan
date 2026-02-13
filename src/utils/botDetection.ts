import { WASocket } from '@whiskeysockets/baileys';

export interface BotScore {
  score: number;
  reasons: string[];
  isBot: boolean;
}

// Suspicious name patterns that indicate bots
const BOT_NAME_PATTERNS = [
  /^user\d+$/i,                    // "User123", "user456"
  /^whatsapp\s*user/i,             // "WhatsApp User"
  /^\+?\d[\d\s-]+$/,               // Just a phone number as name
  /^test\d*/i,                     // "Test", "Test123"
  /^\d{5,}$/,                      // Just numbers (5+ digits)
  /^[a-z]{20,}$/i,                 // Random long string
];

// Suspicious phone number patterns
const SUSPICIOUS_PHONE_PATTERNS = [
  /^(\d)\1{8,}/,                   // Repeating digits (e.g., 1111111111)
  /^(012|123|234|345|456|567|678|789)/, // Sequential patterns
];

/**
 * Analyze a user's profile and calculate bot suspicion score.
 * Score ranges from 0 (definitely human) to 5+ (definitely bot)
 */
export async function calculateBotScore(
  sock: WASocket,
  jid: string
): Promise<BotScore> {
  let score = 0;
  const reasons: string[] = [];

  try {
    // Get user profile picture
    let hasProfilePic = false;
    try {
      const profilePicUrl = await sock.profilePictureUrl(jid, 'image');
      hasProfilePic = !!profilePicUrl;
    } catch (err) {
      // No profile picture or error fetching it
      hasProfilePic = false;
    }

    if (!hasProfilePic) {
      score += 2;
      reasons.push('no_profile_picture');
    }

    // Note: Display name/status analysis removed as fetchStatus is not reliable
    // for analyzing other users' profiles. We rely on profile picture and phone patterns instead.

    // Analyze phone number patterns
    const phoneNumber = jid.replace('@s.whatsapp.net', '');
    const matchesSuspiciousPhone = SUSPICIOUS_PHONE_PATTERNS.some(pattern =>
      pattern.test(phoneNumber)
    );
    if (matchesSuspiciousPhone) {
      score += 1;
      reasons.push('suspicious_phone_pattern');
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] [BotDetection] Error analyzing ${jid}:`, error);
    // On error, give a neutral score and reason
    score += 1;
    reasons.push('profile_fetch_error');
  }

  const isBot = score >= 3;

  return {
    score,
    reasons,
    isBot,
  };
}

/**
 * Analyze multiple users at once for mass join detection.
 * Returns array of scores indexed by jid.
 */
export async function calculateBotScores(
  sock: WASocket,
  jids: string[]
): Promise<Map<string, BotScore>> {
  const scores = new Map<string, BotScore>();

  // Process all users in parallel for speed
  const results = await Promise.allSettled(
    jids.map(jid => calculateBotScore(sock, jid))
  );

  results.forEach((result, index) => {
    const jid = jids[index];
    if (result.status === 'fulfilled') {
      scores.set(jid, result.value);
    } else {
      // On error, mark as suspicious but not auto-reject
      scores.set(jid, {
        score: 2,
        reasons: ['analysis_failed'],
        isBot: false,
      });
    }
  });

  return scores;
}

/**
 * Check if multiple accounts joined at the same time (mass join attack).
 * If 3+ users in the waiting list have similar join times, increase all their scores.
 */
export function detectMassJoin(
  requestCount: number
): { isMassJoin: boolean; scoreModifier: number } {
  // If 5+ requests at once, very suspicious
  if (requestCount >= 5) {
    return { isMassJoin: true, scoreModifier: 2 };
  }

  // If 3-4 requests, somewhat suspicious
  if (requestCount >= 3) {
    return { isMassJoin: true, scoreModifier: 1 };
  }

  return { isMassJoin: false, scoreModifier: 0 };
}

/**
 * Format bot score for logging/display.
 */
export function formatBotScore(score: BotScore): string {
  return `Score: ${score.score}, Reasons: [${score.reasons.join(', ')}], IsBot: ${score.isBot}`;
}
