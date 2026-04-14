/**
 * Tavily Web Search Service
 * Provides real-time web search capabilities for fresh data queries
 * RESTRICTED: Can be limited to specific users/groups via TAVILY_ADMIN_NUMBERS and TAVILY_PUBLIC_GROUPS env vars
 * CACHED: Similar queries within TTL are served from Supabase cache
 */

import { getDb } from '../db';

const TAVILY_API_URL = 'https://api.tavily.com/search';
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';

// Authorization: Admins who can use web search (configured via TAVILY_ADMIN_NUMBERS env var)
const AUTHORIZED_ADMINS = new Set(
  (process.env.TAVILY_ADMIN_NUMBERS || process.env.AGENT_ADMIN_NUMBERS || '').split(',').map(n => n.trim()).filter(n => n)
);

// Groups where all users can use web search (configured via TAVILY_PUBLIC_GROUPS env var)
const PUBLIC_SEARCH_GROUPS = new Set(
  (process.env.TAVILY_PUBLIC_GROUPS || process.env.AGENT_PUBLIC_GROUPS || '').split(',').map(g => g.trim()).filter(g => g)
);

// Cache configuration
const CACHE_TTL_SECONDS = 2 * 60 * 60; // 2 hours - news results stay fresh for a while

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilyResponse {
  query: string;
  answer?: string;
  results: TavilySearchResult[];
  response_time: number;
}

interface CachedSearch {
  answer: string | null;
  results: TavilySearchResult[];
  timestamp: number;
}

/**
 * Keywords and patterns that indicate a query needs fresh/real-time data
 * Includes Hebrew and English patterns
 */
const FRESH_DATA_PATTERNS = [
  // Explicit search/browse commands (Hebrew)
  /תחפש/i,
  /חפש/i,
  /חיפוש/i,
  /תמצא/i,
  /תבדוק/i,
  /בדוק/i,
  /תסתכל על/i,
  /תגלוש ל/i,
  /גלוש ל/i,
  /תכנס ל/i,
  /כנס ל/i,
  /צא לאינטרנט/i,
  /תצא לאינטרנט/i,
  /לך לאינטרנט/i,
  /תלך לאינטרנט/i,
  /חפש באינטרנט/i,
  /תחפש באינטרנט/i,
  /חפש ברשת/i,
  /תחפש ברשת/i,
  /חפש לי/i,
  /תחפש לי/i,
  /מצא לי/i,
  /תמצא לי/i,
  /תביא לי/i,
  /תביא מידע/i,
  /תשלוף/i,
  /שלוף/i,
  /תגלה/i,
  /גלה/i,

  // Explicit search/browse commands (English)
  /browse/i,
  /search for/i,
  /search the web/i,
  /look up/i,
  /look for/i,
  /find me/i,
  /find out/i,
  /check out/i,
  /go to/i,
  /visit/i,
  /google/i,
  /web search/i,

  // URL patterns - if message contains a URL, likely needs web
  /https?:\/\//i,
  /www\./i,
  /\.com/i,
  /\.io/i,
  /\.org/i,
  /github\.com/i,

  // Hebrew patterns for fresh data
  /חידוש/i,
  /חדש/i,
  /חדשות/i,
  /ספר לי משהו חדש/i,
  /תן לי חידוש/i,
  /מה קורה ב/i,
  /מה חדש ב/i,
  /עדכונים/i,
  /עדכון/i,
  /אקטואליה/i,
  /היום/i,
  /השבוע/i,
  /לאחרונה/i,
  /גרסה/i,
  /גרסא/i,
  /version/i,

  // English patterns for fresh data
  /tell me something new/i,
  /what's new/i,
  /what's happening/i,
  /latest news/i,
  /latest version/i,
  /recent developments/i,
  /current events/i,
  /breaking news/i,
  /update me/i,
  /what happened/i,
  /today in/i,
  /this week/i,
  /recently/i,
  /fresh info/i,
  /real.?time/i,
  /now happening/i,
  /trending/i,

  // AI-related fresh data queries (common for this bot)
  /חדשות ai/i,
  /חדשות בינה מלאכותית/i,
  /מה חדש ב.*ai/i,
  /ai news/i,
  /latest.*ai/i,
  /new.*ai.*model/i,
  /חדש.*מודל/i,
];

/**
 * Check if a user is authorized to use Tavily web search
 * Rules:
 * - Admins (configured via TAVILY_ADMIN_NUMBERS): Always authorized (DMs and groups)
 * - Users in public search groups (configured via TAVILY_PUBLIC_GROUPS): Authorized when in those groups
 * - Everyone else: NOT authorized (unless no restrictions configured)
 */
export function isAuthorizedForWebSearch(groupId: string, senderNumber: string): boolean {
  // Normalize sender number for comparison
  const normalizedSender = senderNumber.replace(/[^0-9]/g, '');

  // Admins are always authorized
  if (AUTHORIZED_ADMINS.has(normalizedSender)) {
    console.log(`[TAVILY] Authorized: admin ${senderNumber}`);
    return true;
  }

  // If no restrictions configured, allow all users (default open access)
  if (AUTHORIZED_ADMINS.size === 0 && PUBLIC_SEARCH_GROUPS.size === 0) {
    console.log(`[TAVILY] Authorized: ${senderNumber} (no restrictions configured)`);
    return true;
  }

  // Public search groups - all users authorized
  if (groupId && PUBLIC_SEARCH_GROUPS.has(groupId)) {
    console.log(`[TAVILY] Authorized: ${senderNumber} in public search group`);
    return true;
  }

  // Everyone else is NOT authorized
  console.log(`[TAVILY] Not authorized: ${senderNumber} in ${groupId}`);
  return false;
}

/**
 * Check if a message requires fresh/real-time data
 */
export function needsFreshData(message: string): boolean {
  return FRESH_DATA_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * Extract a search query from the user's message
 * Cleans up the message and extracts the core search intent
 */
function extractSearchQuery(message: string): string {
  // Remove common bot mention patterns
  let query = message
    .replace(/@\d+/g, '') // Remove @mentions
    .replace(/לוגאן/gi, '')
    .replace(/logan/gi, '')
    .trim();

  // If the query is too short after cleanup, use the original
  if (query.length < 5) {
    query = message;
  }

  // Add context for better search results
  // If it's a generic "tell me something new" without topic, focus on AI
  if (/^(תן לי חידוש|ספר לי משהו חדש|tell me something new|what's new)$/i.test(query.trim())) {
    query = 'latest AI news and developments today';
  }

  return query;
}

/**
 * Normalize query for cache matching
 * Makes queries comparable by lowercasing and removing extra whitespace
 */
function normalizeQueryForCache(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Check Supabase cache for a recent similar query
 */
async function getCachedSearch(searchQuery: string): Promise<CachedSearch | null> {
  const normalizedQuery = normalizeQueryForCache(searchQuery);
  const cacheThreshold = Math.floor(Date.now() / 1000) - CACHE_TTL_SECONDS;

  try {
    const sql = getDb();
    const rows = await sql<{ answer: string; results: TavilySearchResult[]; timestamp: number }[]>`
      SELECT answer, results, timestamp
      FROM tavily_searches
      WHERE search_query_normalized = ${normalizedQuery}
        AND timestamp >= ${cacheThreshold}
      ORDER BY timestamp DESC
      LIMIT 1
    `;

    if (rows.length === 0) return null;

    const data = rows[0];
    const age = Math.floor(Date.now() / 1000) - data.timestamp;
    console.log(`[TAVILY] Cache HIT! Query "${searchQuery}" found (age: ${Math.floor(age / 60)} minutes)`);
    return { answer: data.answer, results: data.results, timestamp: data.timestamp };
  } catch (err: any) {
    if (err.code !== '42P01' && err.code !== '42703') {
      console.log('[TAVILY] Cache lookup exception:', err);
    }
    return null;
  }
}

/**
 * Save Tavily search to Supabase for logging/analytics and caching
 */
async function saveTavilySearchToSupabase(
  chatId: string,
  senderNumber: string,
  senderName: string,
  originalQuery: string,
  searchQuery: string,
  answer: string | null,
  results: TavilySearchResult[],
  responseTime: number,
  fromCache: boolean = false
): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      INSERT INTO tavily_searches (
        chat_id, sender_number, sender_name, original_query, search_query,
        search_query_normalized, answer, results, results_count, response_time,
        from_cache, timestamp
      ) VALUES (
        ${chatId}, ${senderNumber}, ${senderName}, ${originalQuery}, ${searchQuery},
        ${normalizeQueryForCache(searchQuery)}, ${answer}, ${sql.json(results as any)},
        ${results.length}, ${responseTime}, ${fromCache}, ${Math.floor(Date.now() / 1000)}
      )
    `;
    console.log(`[TAVILY] Search saved to database (from_cache: ${fromCache})`);
  } catch (err: any) {
    if (err.code === '42P01') {
      console.log('[TAVILY] tavily_searches table does not exist yet, skipping save');
    } else {
      console.error('[TAVILY] Exception saving search:', err);
    }
  }
}

/**
 * Legacy save without new columns (for backwards compatibility)
 */
async function saveTavilySearchLegacy(
  chatId: string,
  senderNumber: string,
  senderName: string,
  originalQuery: string,
  searchQuery: string,
  answer: string | null,
  results: TavilySearchResult[],
  responseTime: number
): Promise<void> {
  try {
    const sql = getDb();
    await sql`
      INSERT INTO tavily_searches (
        chat_id, sender_number, sender_name, original_query, search_query,
        answer, results, results_count, response_time, timestamp
      ) VALUES (
        ${chatId}, ${senderNumber}, ${senderName}, ${originalQuery}, ${searchQuery},
        ${answer}, ${sql.json(results as any)}, ${results.length}, ${responseTime},
        ${Math.floor(Date.now() / 1000)}
      )
    `;
  } catch (err: any) {
    console.error('[TAVILY] Legacy save error:', err.message);
  }
}

/**
 * Search Tavily for real-time web results (with caching)
 */
export async function searchTavily(
  userQuery: string,
  chatId: string,
  senderNumber: string,
  senderName: string
): Promise<{
  answer: string | null;
  results: TavilySearchResult[];
  fromCache?: boolean;
  error?: string;
}> {
  const searchQuery = extractSearchQuery(userQuery);

  console.log(`[TAVILY] Searching for: "${searchQuery}"`);

  // Check cache first
  const cached = await getCachedSearch(searchQuery);
  if (cached) {
    // Log the cache hit (don't save as new entry, just log usage)
    saveTavilySearchToSupabase(
      chatId,
      senderNumber,
      senderName,
      userQuery,
      searchQuery,
      cached.answer,
      cached.results,
      0, // No API response time for cache
      true // from_cache = true
    ).catch(err => console.error('[TAVILY] Background cache log error:', err));

    return {
      answer: cached.answer,
      results: cached.results,
      fromCache: true
    };
  }

  console.log(`[TAVILY] Cache MISS, calling Tavily API...`);

  try {
    const response = await fetch(TAVILY_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TAVILY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: searchQuery,
        search_depth: 'basic',
        max_results: 5,
        include_answer: 'basic',
        topic: 'news',
        time_range: 'week'
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[TAVILY] API error ${response.status}: ${errorText}`);
      return { answer: null, results: [], error: `API error: ${response.status}` };
    }

    const data = await response.json() as TavilyResponse;

    console.log(`[TAVILY] Got ${data.results.length} results in ${data.response_time}s`);

    // Save to Supabase for caching and logging (async, don't wait)
    saveTavilySearchToSupabase(
      chatId,
      senderNumber,
      senderName,
      userQuery,
      searchQuery,
      data.answer || null,
      data.results,
      data.response_time,
      false // from_cache = false (fresh API result)
    ).catch(err => console.error('[TAVILY] Background save error:', err));

    return {
      answer: data.answer || null,
      results: data.results,
      fromCache: false
    };
  } catch (error) {
    console.error('[TAVILY] Search error:', error);
    return { answer: null, results: [], error: String(error) };
  }
}

/**
 * Format Tavily results for inclusion in AI prompt
 */
export function formatTavilyResultsForPrompt(
  results: TavilySearchResult[],
  answer: string | null
): string {
  if (results.length === 0 && !answer) {
    return '';
  }

  let formatted = '\n\n=== REAL-TIME WEB SEARCH RESULTS ===\n';

  if (answer) {
    formatted += `Summary: ${answer}\n\n`;
  }

  formatted += 'Sources:\n';
  results.slice(0, 3).forEach((result, i) => {
    formatted += `${i + 1}. ${result.title}\n   ${result.content.slice(0, 200)}...\n   Source: ${result.url}\n\n`;
  });

  formatted += '=== END WEB SEARCH RESULTS ===\n';
  formatted += 'CRITICAL INSTRUCTIONS FOR WEB SEARCH:\n';
  formatted += '1. Use ONLY the information from the web search results above - DO NOT make up any facts!\n';
  formatted += '2. If the search results are NOT RELEVANT to the question, say "לא מצאתי מידע עדכני על זה" and DO NOT add any source link!\n';
  formatted += '3. ONLY if you found relevant info AND used it in your answer - add the source URL at the end!\n';
  formatted += '4. Format (only when you HAVE relevant info): After your answer, add "🔗 מקור: [URL]"\n';
  formatted += '5. Pick the most relevant source URL from the results above - ONLY use URLs from the search results!\n';
  formatted += '6. If the search results don\'t answer the question - DO NOT add a source link! Just say you didn\'t find info.\n';
  formatted += '7. NEVER invent URLs! If you say "לא מצאתי" - NO URL should appear in your response!';

  return formatted;
}

/**
 * Extract URLs from search results for validation
 */
export function extractSearchResultUrls(results: TavilySearchResult[]): string[] {
  return results.map(r => {
    // Extract domain from full URL for flexible matching
    try {
      const url = new URL(r.url);
      return url.hostname.replace('www.', '');
    } catch {
      return r.url;
    }
  });
}

/**
 * Check if response indicates no relevant info was found
 */
function responseIndicatesNoInfo(response: string): boolean {
  const noInfoPatterns = [
    /לא מצאתי מידע/i,
    /לא מצאתי תוצאות/i,
    /לא נמצא מידע/i,
    /אין לי מידע/i,
    /לא יודע/i,
    /לא הצלחתי למצוא/i,
    /didn't find/i,
    /could not find/i,
    /no information/i,
    /no relevant/i,
  ];
  return noInfoPatterns.some(pattern => pattern.test(response));
}

/**
 * Validate that a response actually uses sources from the search results
 * Returns validation result with details
 */
export function validateResponseSources(
  response: string,
  searchResults: TavilySearchResult[]
): { isValid: boolean; foundUrls: string[]; expectedDomains: string[]; suggestion?: string } {
  if (searchResults.length === 0) {
    return { isValid: true, foundUrls: [], expectedDomains: [], suggestion: undefined };
  }

  // IMPORTANT: If response says "I didn't find info", don't suggest adding a URL!
  // This prevents adding irrelevant URLs when the search didn't help
  if (responseIndicatesNoInfo(response)) {
    console.log('[TAVILY] Response indicates no relevant info found - NOT suggesting URL');
    return { isValid: true, foundUrls: [], expectedDomains: extractSearchResultUrls(searchResults), suggestion: undefined };
  }

  // Extract domains from search results
  const expectedDomains = extractSearchResultUrls(searchResults);

  // Find URLs in the response
  const urlPattern = /https?:\/\/[^\s\])"'<>]+/gi;
  const foundUrls = response.match(urlPattern) || [];

  // Also check for domain mentions without full URL
  const responseText = response.toLowerCase();

  // Check if any expected domain appears in the response
  let hasValidSource = false;
  for (const domain of expectedDomains) {
    if (responseText.includes(domain.toLowerCase())) {
      hasValidSource = true;
      break;
    }
  }

  // Also check if any found URL matches an expected domain
  for (const url of foundUrls) {
    try {
      const urlObj = new URL(url);
      const urlDomain = urlObj.hostname.replace('www.', '');
      if (expectedDomains.some(d => urlDomain.includes(d) || d.includes(urlDomain))) {
        hasValidSource = true;
        break;
      }
    } catch {
      // Invalid URL, skip
    }
  }

  // If no valid source found AND response has actual content (not "didn't find"), suggest adding one
  let suggestion: string | undefined;
  if (!hasValidSource && searchResults.length > 0) {
    const bestResult = searchResults[0];
    suggestion = `\n\n🔗 מקור: ${bestResult.url}`;
  }

  return {
    isValid: hasValidSource,
    foundUrls,
    expectedDomains,
    suggestion
  };
}

/**
 * Check if a response appears to be hallucinated (contains fabricated-looking URLs)
 */
export function detectHallucinatedUrls(response: string): string[] {
  const urlPattern = /https?:\/\/[^\s\])"'<>]+/gi;
  const foundUrls = response.match(urlPattern) || [];

  const suspiciousUrls: string[] = [];

  for (const url of foundUrls) {
    try {
      const urlObj = new URL(url);
      // Check for common hallucination patterns:
      // 1. Very long random-looking paths
      // 2. Paths with lots of numbers
      // 3. Domains that look made up (very long, unusual TLDs)
      const path = urlObj.pathname;
      const domain = urlObj.hostname;

      // Suspicious if path has lots of random numbers/hashes
      const hashPattern = /[a-f0-9]{20,}/i;
      if (hashPattern.test(path)) {
        suspiciousUrls.push(url);
        continue;
      }

      // Suspicious if domain is unusually long (likely made up)
      if (domain.length > 40) {
        suspiciousUrls.push(url);
        continue;
      }

      // Check for clearly fake looking domains
      const fakeDomainPatterns = [
        /example\d+\.com/i,
        /test\d+\.com/i,
        /fake[a-z]+\.com/i,
      ];
      if (fakeDomainPatterns.some(p => p.test(domain))) {
        suspiciousUrls.push(url);
      }
    } catch {
      // Invalid URL is suspicious
      suspiciousUrls.push(url);
    }
  }

  return suspiciousUrls;
}
