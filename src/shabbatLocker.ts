import { getSocket, isStable } from './connection';
import { ALLOWED_GROUPS } from './config';
import * as fs from 'fs';
import * as path from 'path';
import {
  canBroadcast,
  markBroadcastStarted,
  markBroadcastCompleted,
  markBroadcastFailed,
  recordGroupSent,
  hasGroupReceived,
  getOperationKey,
  BroadcastType
} from './broadcastGuard';

// Configuration from environment variables
const SHABBAT_ENABLED = process.env.SHABBAT_ENABLED === 'true';

// File to persist lock state across restarts
const LOCK_STATE_FILE = path.join(__dirname, '..', 'shabbat_lock_state.json');

// File to cache Shabbat times (survives restart, no API needed)
const SHABBAT_TIMES_CACHE_FILE = path.join(__dirname, '..', 'shabbat_times_cache.json');

interface LockState {
  isLocked: boolean;
  lockedAt: string | null;
  unlockScheduledFor: string | null;
}

interface ShabbatTimesCache {
  lockTime: string | null;
  unlockTime: string | null;
  candleLightingDisplay: string | null;
  havdalahDisplay: string | null;
  fetchedAt: string;
}

function readLockState(): LockState {
  try {
    if (fs.existsSync(LOCK_STATE_FILE)) {
      const data = fs.readFileSync(LOCK_STATE_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [Shabbat] Error reading lock state file:`, error);
  }
  return { isLocked: false, lockedAt: null, unlockScheduledFor: null };
}

function writeLockState(state: LockState): void {
  try {
    fs.writeFileSync(LOCK_STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`[${new Date().toISOString()}] [Shabbat] Lock state saved: isLocked=${state.isLocked}`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [Shabbat] Error writing lock state file:`, error);
  }
}

function clearLockState(): void {
  writeLockState({ isLocked: false, lockedAt: null, unlockScheduledFor: null });
}

/**
 * Save Shabbat times to cache file (survives restarts without API fetch)
 */
function saveShabbatTimesCache(): void {
  try {
    const cache: ShabbatTimesCache = {
      lockTime: todaysLockTime?.toISOString() || null,
      unlockTime: todaysUnlockTime?.toISOString() || null,
      candleLightingDisplay,
      havdalahDisplay,
      fetchedAt: new Date().toISOString(),
    };
    fs.writeFileSync(SHABBAT_TIMES_CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log(`[${new Date().toISOString()}] [Shabbat] Saved times cache to file`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [Shabbat] Error saving times cache:`, err);
  }
}

/**
 * Load Shabbat times from cache file (SYNCHRONOUS - runs before any async operations)
 * Returns true if cache was loaded and is still relevant
 */
function loadShabbatTimesCache(): boolean {
  try {
    if (!fs.existsSync(SHABBAT_TIMES_CACHE_FILE)) return false;

    const data = fs.readFileSync(SHABBAT_TIMES_CACHE_FILE, 'utf-8');
    const cache: ShabbatTimesCache = JSON.parse(data);

    // Only use cache if fetched within last 48 hours (covers Friday -> Saturday)
    const fetchedAt = new Date(cache.fetchedAt);
    const now = new Date();
    const hoursSinceFetch = (now.getTime() - fetchedAt.getTime()) / (1000 * 60 * 60);
    if (hoursSinceFetch > 48) {
      console.log(`[${new Date().toISOString()}] [Shabbat] Times cache too old (${Math.round(hoursSinceFetch)}h), ignoring`);
      return false;
    }

    if (cache.lockTime) todaysLockTime = new Date(cache.lockTime);
    if (cache.unlockTime) todaysUnlockTime = new Date(cache.unlockTime);
    if (cache.candleLightingDisplay) candleLightingDisplay = cache.candleLightingDisplay;
    if (cache.havdalahDisplay) havdalahDisplay = cache.havdalahDisplay;

    console.log(`[${new Date().toISOString()}] [Shabbat] Loaded times from cache (fetched ${Math.round(hoursSinceFetch)}h ago)`);
    console.log(`[${new Date().toISOString()}] [Shabbat] Cached lock: ${todaysLockTime?.toISOString() || 'N/A'}`);
    console.log(`[${new Date().toISOString()}] [Shabbat] Cached unlock: ${todaysUnlockTime?.toISOString() || 'N/A'}`);

    return true;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] [Shabbat] Error loading times cache:`, err);
    return false;
  }
}

/**
 * LAST RESORT FALLBACK: Check if it's likely Shabbat based on Israel timezone
 * Used when Hebcal API is down AND no cache exists
 * Conservative window: Friday 15:30 - Saturday 20:30 Israel time
 * This covers the earliest possible candle lighting (winter) to latest havdalah (summer)
 */
function isLikelyShabbatByTimezone(): boolean {
  try {
    // Get current Israel time
    const israelTimeStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' });
    const israelDate = new Date(israelTimeStr);
    const day = israelDate.getDay(); // 0=Sunday, 5=Friday, 6=Saturday
    const hour = israelDate.getHours();
    const minutes = israelDate.getMinutes();
    const timeInMinutes = hour * 60 + minutes;

    // Friday after 15:30 (930 min) Israel time
    if (day === 5 && timeInMinutes >= 930) return true;

    // All day Saturday until 20:30 (1230 min) Israel time
    if (day === 6 && timeInMinutes < 1230) return true;

    return false;
  } catch {
    return false;
  }
}

const SHABBAT_LOCK_LOCATION = process.env.SHABBAT_LOCK_LOCATION || '281184'; // Jerusalem
const SHABBAT_UNLOCK_LOCATION = process.env.SHABBAT_UNLOCK_LOCATION || '294801'; // Haifa
const SHABBAT_LOCK_OFFSET = parseInt(process.env.SHABBAT_LOCK_OFFSET || '-30', 10); // minutes
const SHABBAT_UNLOCK_OFFSET = parseInt(process.env.SHABBAT_UNLOCK_OFFSET || '30', 10); // minutes

// Track scheduled timers for cleanup
let scheduledLockTimer: NodeJS.Timeout | null = null;
let scheduledUnlockTimer: NodeJS.Timeout | null = null;
let dailyScheduleTimer: NodeJS.Timeout | null = null;

// Track which groups have been locked during this Shabbat period
// Prevents duplicate lock messages on reconnects
const lockedGroupsThisShabbat = new Set<string>();

// Hebcal API response types
interface HebcalItem {
  title: string;
  date: string;
  category: string;
  hebrew?: string;
  memo?: string;
}

interface HebcalResponse {
  title: string;
  date: string;
  location: {
    title: string;
    city: string;
    geo: string;
  };
  items: HebcalItem[];
}

// Store today's scheduled times for logging and API
let todaysLockTime: Date | null = null;
let todaysUnlockTime: Date | null = null;

// Store display times (Jerusalem times) for messages
let candleLightingDisplay: string | null = null;
let havdalahDisplay: string | null = null;

/**
 * Format a Date object to HH:MM string
 */
function formatTime(date: Date): string {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Fetch Shabbat/holiday times from Hebcal API
 */
async function fetchHebcalTimes(geonameid: string): Promise<HebcalResponse | null> {
  const url = `https://www.hebcal.com/shabbat?cfg=json&geonameid=${geonameid}&M=on`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json() as HebcalResponse;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [Shabbat] Failed to fetch Hebcal API:`, error);
    return null;
  }
}

/**
 * Extract candle lighting time from Hebcal response
 * Returns the earliest candle lighting time for today
 */
function getCandleLightingTime(data: HebcalResponse): Date | null {
  const today = new Date().toISOString().split('T')[0];

  // Find candle lighting events for today
  const candleLighting = data.items.filter(item =>
    item.category === 'candles' && item.date.startsWith(today)
  );

  if (candleLighting.length === 0) {
    return null;
  }

  // Get the earliest candle lighting time
  const times = candleLighting.map(item => new Date(item.date));
  return times.reduce((earliest, current) =>
    current < earliest ? current : earliest
  );
}

/**
 * Extract havdalah time from Hebcal response
 * Returns the latest havdalah time for today or tomorrow (for two-day holidays)
 */
function getHavdalahTime(data: HebcalResponse): Date | null {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const todayStr = today.toISOString().split('T')[0];
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  // Find havdalah events for today or tomorrow
  const havdalah = data.items.filter(item =>
    item.category === 'havdalah' &&
    (item.date.startsWith(todayStr) || item.date.startsWith(tomorrowStr))
  );

  if (havdalah.length === 0) {
    return null;
  }

  // Get the latest havdalah time (for two-day holidays)
  const times = havdalah.map(item => new Date(item.date));
  return times.reduce((latest, current) =>
    current > latest ? current : latest
  );
}

/**
 * Apply time offset in minutes
 */
function applyOffset(date: Date, offsetMinutes: number): Date {
  const result = new Date(date.getTime());
  result.setMinutes(result.getMinutes() + offsetMinutes);
  return result;
}

/**
 * Check if groups are already locked (from file state)
 * Returns true if we should do NOTHING on reconnect
 */
export function areGroupsAlreadyLocked(): boolean {
  const state = readLockState();
  return state.isLocked;
}

/**
 * Send Shabbat lock message and lock all monitored groups
 * Flow: Send message -> Wait 3s -> Lock group (repeat for each group with 5s delay)
 * ONLY called from scheduled timer at actual lock time, NEVER on reconnects
 */
export async function lockGroups(skipStabilityCheck: boolean = false): Promise<void> {
  const sock = getSocket();

  if (!sock || (!skipStabilityCheck && !isStable())) {
    console.error(`[${new Date().toISOString()}] [Shabbat] Cannot lock groups - socket not ${skipStabilityCheck ? 'available' : 'stable'}`);
    return;
  }

  // ATOMIC CHECK: Supabase broadcast guard (prevents duplicate locks even with rapid reconnects)
  const broadcastType: BroadcastType = 'shabbat-lock';
  const canProceed = await canBroadcast(broadcastType);
  if (!canProceed.canProceed) {
    console.log(`[${new Date().toISOString()}] [Shabbat] Broadcast guard BLOCKED lock: ${canProceed.reason}`);
    // Guard blocked = another process already locked. Ensure lock state file is consistent.
    writeLockState({
      isLocked: true,
      lockedAt: new Date().toISOString(),
      unlockScheduledFor: todaysUnlockTime?.toISOString() || null
    });
    return;
  }

  // Mark as started in Supabase (atomic)
  const supabaseRunId = await markBroadcastStarted(broadcastType);
  const operationKey = getOperationKey(broadcastType);

  // Filter out groups that have already been locked this Shabbat (in-memory) or received broadcast (Supabase)
  const groupsToLock: typeof ALLOWED_GROUPS = [];
  for (const g of ALLOWED_GROUPS) {
    if (lockedGroupsThisShabbat.has(g.id)) continue;
    const alreadyReceived = await hasGroupReceived(broadcastType, g.id);
    if (!alreadyReceived) {
      groupsToLock.push(g);
    }
  }

  if (groupsToLock.length === 0) {
    console.log(`[${new Date().toISOString()}] [Shabbat] All groups already locked this Shabbat, skipping`);
    if (supabaseRunId) {
      await markBroadcastCompleted(operationKey, supabaseRunId);
    }
    return;
  }

  console.log(`[${new Date().toISOString()}] [Shabbat] 🔒 Locking ${groupsToLock.length} groups for Shabbat/Holiday...`);
  if (lockedGroupsThisShabbat.size > 0) {
    console.log(`[${new Date().toISOString()}] [Shabbat] (${lockedGroupsThisShabbat.size} groups already locked, skipping those)`);
  }

  // Build the lock message
  const lockMessage = `קהילה יקרה, נועל לדיונים עד מוצ"ש.
🕯️ כניסת שבת והדלקת נרות: ${candleLightingDisplay || 'N/A'}
✨ יציאת השבת: ${havdalahDisplay || 'N/A'}
שבת שלום!`;

  let success = true;

  for (const group of groupsToLock) {
    try {
      // Step 1: Send message
      console.log(`[${new Date().toISOString()}] [Shabbat] Sending lock message to ${group.name}...`);
      await sock.sendMessage(group.id, { text: lockMessage });
      console.log(`[${new Date().toISOString()}] [Shabbat] ✓ Message sent to ${group.name}`);

      // Step 2: Wait 3 seconds
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Step 3: Lock the group
      await sock.groupSettingUpdate(group.id, 'announcement');
      console.log(`[${new Date().toISOString()}] [Shabbat] ✓ Locked: ${group.name}`);

      // Mark this group as locked for this Shabbat period (in-memory)
      lockedGroupsThisShabbat.add(group.id);

      // Record in Supabase (survives restarts)
      if (supabaseRunId) {
        await recordGroupSent(operationKey, supabaseRunId, group.id);
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] [Shabbat] ✗ Failed to lock ${group.name}:`, error);
      success = false;
    }

    // Wait 5 seconds between groups to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  // Save lock state to file so we don't do anything on reconnects (fallback)
  writeLockState({
    isLocked: true,
    lockedAt: new Date().toISOString(),
    unlockScheduledFor: todaysUnlockTime?.toISOString() || null
  });

  // Mark broadcast as completed/failed in Supabase
  if (supabaseRunId) {
    if (success) {
      await markBroadcastCompleted(operationKey, supabaseRunId);
    } else {
      await markBroadcastFailed(operationKey, supabaseRunId, 'Some groups failed to lock');
    }
  }

  console.log(`[${new Date().toISOString()}] [Shabbat] 🔒 Group locking complete`);
}

/**
 * Unlock all monitored groups and send Shabbat end message
 * Flow: Unlock group -> Wait 2s -> Send message (repeat for each group with 5s delay)
 */
export async function unlockGroups(skipStabilityCheck: boolean = false): Promise<void> {
  const sock = getSocket();

  if (!sock || (!skipStabilityCheck && !isStable())) {
    console.error(`[${new Date().toISOString()}] [Shabbat] Cannot unlock groups - socket not ${skipStabilityCheck ? 'available' : 'stable'}`);
    return;
  }

  // ATOMIC CHECK: Supabase broadcast guard (prevents duplicate unlocks even with rapid reconnects)
  const broadcastType: BroadcastType = 'shabbat-unlock';
  const canProceed = await canBroadcast(broadcastType);
  if (!canProceed.canProceed) {
    console.log(`[${new Date().toISOString()}] [Shabbat] Broadcast guard BLOCKED unlock: ${canProceed.reason}`);
    // Guard blocked = another process already unlocked. Clear lock state to stay consistent.
    lockedGroupsThisShabbat.clear();
    clearLockState();
    return;
  }

  // Mark as started in Supabase (atomic)
  const supabaseRunId = await markBroadcastStarted(broadcastType);
  const operationKey = getOperationKey(broadcastType);

  // Filter out groups that already received unlock message (Supabase)
  const groupsToUnlock: typeof ALLOWED_GROUPS = [];
  for (const g of ALLOWED_GROUPS) {
    const alreadyReceived = await hasGroupReceived(broadcastType, g.id);
    if (!alreadyReceived) {
      groupsToUnlock.push(g);
    }
  }

  if (groupsToUnlock.length === 0) {
    console.log(`[${new Date().toISOString()}] [Shabbat] All groups already unlocked, skipping`);
    if (supabaseRunId) {
      await markBroadcastCompleted(operationKey, supabaseRunId);
    }
    // Still clear the state
    lockedGroupsThisShabbat.clear();
    clearLockState();
    return;
  }

  console.log(`[${new Date().toISOString()}] [Shabbat] 🔓 Unlocking ${groupsToUnlock.length} groups after Shabbat/Holiday...`);

  const unlockMessage = `קהילה יקרה, פותח חזרה לדיונים. שבוע טוב!`;

  let success = true;

  for (const group of groupsToUnlock) {
    try {
      // Step 1: Unlock the group first
      await sock.groupSettingUpdate(group.id, 'not_announcement');
      console.log(`[${new Date().toISOString()}] [Shabbat] ✓ Unlocked: ${group.name}`);

      // Step 2: Wait 2 seconds
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 3: Send message
      console.log(`[${new Date().toISOString()}] [Shabbat] Sending unlock message to ${group.name}...`);
      await sock.sendMessage(group.id, { text: unlockMessage });
      console.log(`[${new Date().toISOString()}] [Shabbat] ✓ Message sent to ${group.name}`);

      // Record in Supabase (survives restarts)
      if (supabaseRunId) {
        await recordGroupSent(operationKey, supabaseRunId, group.id);
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] [Shabbat] ✗ Failed to unlock ${group.name}:`, error);
      success = false;
    }

    // Wait 5 seconds between groups to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  // Clear the locked groups tracking set for the next Shabbat
  lockedGroupsThisShabbat.clear();

  // Clear the file-based lock state
  clearLockState();

  // Mark broadcast as completed/failed in Supabase
  if (supabaseRunId) {
    if (success) {
      await markBroadcastCompleted(operationKey, supabaseRunId);
    } else {
      await markBroadcastFailed(operationKey, supabaseRunId, 'Some groups failed to unlock');
    }
  }

  console.log(`[${new Date().toISOString()}] [Shabbat] 🔓 Group unlocking complete (tracking reset)`);
}

/**
 * Schedule lock/unlock actions for today
 */
async function scheduleForToday(): Promise<void> {
  // Clear any existing scheduled timers
  if (scheduledLockTimer) {
    clearTimeout(scheduledLockTimer);
    scheduledLockTimer = null;
  }
  if (scheduledUnlockTimer) {
    clearTimeout(scheduledUnlockTimer);
    scheduledUnlockTimer = null;
  }

  // DON'T clear todaysLockTime/todaysUnlockTime here!
  // Keep cached values valid during the async API fetch.
  // They will be overwritten once we have fresh API data.

  console.log(`[${new Date().toISOString()}] [Shabbat] Fetching Shabbat/Holiday times...`);

  // Fetch times from both locations
  const [lockData, unlockData] = await Promise.all([
    fetchHebcalTimes(SHABBAT_LOCK_LOCATION),
    fetchHebcalTimes(SHABBAT_UNLOCK_LOCATION),
  ]);

  // Handle API failures - retry in 1 hour (keep cached values intact)
  if (!lockData || !unlockData) {
    console.error(`[${new Date().toISOString()}] [Shabbat] API fetch failed, will retry in 1 hour (keeping cached values)`);
    setTimeout(scheduleForToday, 60 * 60 * 1000);
    return;
  }

  // API succeeded - now safe to clear old values before setting new ones
  todaysLockTime = null;
  todaysUnlockTime = null;
  candleLightingDisplay = null;
  havdalahDisplay = null;

  console.log(`[${new Date().toISOString()}] [Shabbat] Lock location: ${lockData.location.city}`);
  console.log(`[${new Date().toISOString()}] [Shabbat] Unlock location: ${unlockData.location.city}`);

  // Get candle lighting and havdalah times
  const candleLighting = getCandleLightingTime(lockData);
  const havdalah = getHavdalahTime(unlockData);

  // Store display times (Jerusalem times) for messages
  if (candleLighting) {
    candleLightingDisplay = formatTime(candleLighting);
  }
  // Get havdalah from Jerusalem (lock location) for display
  const jerusalemHavdalah = getHavdalahTime(lockData);
  if (jerusalemHavdalah) {
    havdalahDisplay = formatTime(jerusalemHavdalah);
  }

  const now = new Date();

  // Check if there's candle lighting today
  if (!candleLighting) {
    console.log(`[${new Date().toISOString()}] [Shabbat] No candle lighting today - nothing to schedule`);

    // Check if there's a havdalah today (Shabbat started yesterday)
    // ALWAYS set todaysUnlockTime so isCurrentlyShabbat() works correctly
    if (havdalah) {
      const unlockTime = applyOffset(havdalah, SHABBAT_UNLOCK_OFFSET);
      todaysUnlockTime = unlockTime; // Always set, even if past - critical for isCurrentlyShabbat()

      if (unlockTime > now) {
        const msUntilUnlock = unlockTime.getTime() - now.getTime();
        console.log(`[${new Date().toISOString()}] [Shabbat] Scheduling unlock for ${unlockTime.toLocaleString('he-IL')}`);
        scheduledUnlockTimer = setTimeout(unlockGroups, msUntilUnlock);
      } else {
        console.log(`[${new Date().toISOString()}] [Shabbat] Havdalah+offset already passed: ${unlockTime.toLocaleString('he-IL')} (Shabbat is over)`);
      }
    }
    return;
  }

  // Calculate lock time with offset
  const lockTime = applyOffset(candleLighting, SHABBAT_LOCK_OFFSET);

  // Schedule lock if it's in the future
  if (lockTime > now) {
    todaysLockTime = lockTime;
    const msUntilLock = lockTime.getTime() - now.getTime();

    console.log(`[${new Date().toISOString()}] [Shabbat] Candle lighting: ${candleLighting.toLocaleString('he-IL')} (${candleLightingDisplay})`);
    console.log(`[${new Date().toISOString()}] [Shabbat] Havdalah (Jerusalem): ${jerusalemHavdalah?.toLocaleString('he-IL') || 'N/A'} (${havdalahDisplay})`);
    console.log(`[${new Date().toISOString()}] [Shabbat] Scheduled LOCK for: ${lockTime.toLocaleString('he-IL')} (offset: ${SHABBAT_LOCK_OFFSET} min)`);

    scheduledLockTimer = setTimeout(lockGroups, msUntilLock);
  } else {
    // Lock time already passed - still save it so isCurrentlyShabbat() works correctly
    todaysLockTime = lockTime;
    console.log(`[${new Date().toISOString()}] [Shabbat] Candle lighting time already passed: ${candleLighting.toLocaleString('he-IL')}`);
  }

  // Schedule unlock if havdalah exists
  // ALWAYS set todaysUnlockTime so isCurrentlyShabbat() works correctly
  if (havdalah) {
    const unlockTime = applyOffset(havdalah, SHABBAT_UNLOCK_OFFSET);
    todaysUnlockTime = unlockTime; // Always set, even if past - critical for isCurrentlyShabbat()

    if (unlockTime > now) {
      const msUntilUnlock = unlockTime.getTime() - now.getTime();

      console.log(`[${new Date().toISOString()}] [Shabbat] Havdalah (Haifa): ${havdalah.toLocaleString('he-IL')}`);
      console.log(`[${new Date().toISOString()}] [Shabbat] Scheduled UNLOCK for: ${unlockTime.toLocaleString('he-IL')} (offset: +${SHABBAT_UNLOCK_OFFSET} min)`);

      scheduledUnlockTimer = setTimeout(unlockGroups, msUntilUnlock);
    } else {
      console.log(`[${new Date().toISOString()}] [Shabbat] Havdalah+offset already passed: ${unlockTime.toLocaleString('he-IL')} (Shabbat is over)`);
    }
  }

  // Save times to cache file (so next restart has instant Shabbat detection)
  if (todaysLockTime || todaysUnlockTime) {
    saveShabbatTimesCache();
  }
}

/**
 * Calculate milliseconds until next 00:05
 */
function getMillisecondsUntilNextSchedule(): number {
  const now = new Date();
  const next = new Date(now);

  // Set to 00:05
  next.setHours(0, 5, 0, 0);

  // If it's already past 00:05 today, schedule for tomorrow
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime() - now.getTime();
}

/**
 * Start the daily scheduling loop
 */
function startDailyScheduler(): void {
  // Schedule for today first
  scheduleForToday();

  // Then set up daily scheduling at 00:05
  const scheduleDaily = () => {
    const msUntilNext = getMillisecondsUntilNextSchedule();
    const nextSchedule = new Date(Date.now() + msUntilNext);

    console.log(`[${new Date().toISOString()}] [Shabbat] Next daily check scheduled for: ${nextSchedule.toLocaleString('he-IL')}`);

    dailyScheduleTimer = setTimeout(() => {
      scheduleForToday();
      scheduleDaily(); // Reschedule for next day
    }, msUntilNext);
  };

  scheduleDaily();
}

/**
 * Initialize the Shabbat locker service
 */
export function startShabbatLocker(): void {
  if (!SHABBAT_ENABLED) {
    console.log(`[${new Date().toISOString()}] [Shabbat] Service DISABLED (SHABBAT_ENABLED=false)`);
    return;
  }

  console.log(`[${new Date().toISOString()}] [Shabbat] Service ENABLED`);
  console.log(`[${new Date().toISOString()}] [Shabbat] Lock location: geonameid ${SHABBAT_LOCK_LOCATION}`);
  console.log(`[${new Date().toISOString()}] [Shabbat] Unlock location: geonameid ${SHABBAT_UNLOCK_LOCATION}`);
  console.log(`[${new Date().toISOString()}] [Shabbat] Lock offset: ${SHABBAT_LOCK_OFFSET} minutes`);
  console.log(`[${new Date().toISOString()}] [Shabbat] Unlock offset: +${SHABBAT_UNLOCK_OFFSET} minutes`);
  console.log(`[${new Date().toISOString()}] [Shabbat] Groups to manage: ${ALLOWED_GROUPS.map(g => g.name).join(', ')}`);

  // CRITICAL: Load cached Shabbat times IMMEDIATELY (synchronous)
  // This provides instant Shabbat detection before the async Hebcal API fetch
  const cacheLoaded = loadShabbatTimesCache();
  if (cacheLoaded && isCurrentlyShabbat()) {
    console.log(`[${new Date().toISOString()}] [Shabbat] ⚠️ SHABBAT DETECTED FROM CACHE - Logan will NOT respond until Shabbat ends`);
  }

  startDailyScheduler();
}

/**
 * Stop the Shabbat locker service
 */
export function stopShabbatLocker(): void {
  if (scheduledLockTimer) {
    clearTimeout(scheduledLockTimer);
    scheduledLockTimer = null;
  }
  if (scheduledUnlockTimer) {
    clearTimeout(scheduledUnlockTimer);
    scheduledUnlockTimer = null;
  }
  if (dailyScheduleTimer) {
    clearTimeout(dailyScheduleTimer);
    dailyScheduleTimer = null;
  }
  console.log(`[${new Date().toISOString()}] [Shabbat] Service stopped`);
}

/**
 * Get current Shabbat locker status
 */
export function getShabbatStatus(): {
  enabled: boolean;
  scheduledLock: string | null;
  scheduledUnlock: string | null;
  candleLighting: string | null;
  havdalah: string | null;
} {
  return {
    enabled: SHABBAT_ENABLED,
    scheduledLock: todaysLockTime?.toISOString() || null,
    scheduledUnlock: todaysUnlockTime?.toISOString() || null,
    candleLighting: candleLightingDisplay,
    havdalah: havdalahDisplay,
  };
}

/**
 * Check if today is Erev Shabbat/Holiday (candle lighting scheduled)
 */
export function isErevShabbat(): boolean {
  return todaysLockTime !== null;
}

/**
 * Check if currently Shabbat/Holiday (between lock and unlock)
 * BULLETPROOF: 3 layers of detection:
 *   1. Hebcal API times (most accurate)
 *   2. Cached times from file (survives restarts)
 *   3. Israel timezone heuristic (last resort fallback)
 */
export function isCurrentlyShabbat(): boolean {
  if (!SHABBAT_ENABLED) return false;

  const now = new Date();

  // Layer 1+2: Use fetched or cached times (both set todaysLockTime/todaysUnlockTime)
  if (todaysLockTime && todaysUnlockTime) {
    return now >= todaysLockTime && now < todaysUnlockTime;
  }

  // If only unlock time exists (Shabbat started yesterday)
  if (!todaysLockTime && todaysUnlockTime && now < todaysUnlockTime) {
    return true;
  }

  // Layer 3: FALLBACK - if no times available at all (API down + no cache),
  // use conservative Israel timezone heuristic to block responses
  if (!todaysLockTime && !todaysUnlockTime) {
    return isLikelyShabbatByTimezone();
  }

  return false;
}

/**
 * Get the Erev Shabbat summary time (30 min before candle lighting)
 * Returns null if not Erev Shabbat
 */
export function getErevShabbatSummaryTime(): Date | null {
  if (!todaysLockTime) {
    return null;
  }

  // Return 30 minutes before lock time (which is already offset from candle lighting)
  // Actually, we want 30 min before CANDLE LIGHTING, not lock time
  // Lock time = candle lighting + SHABBAT_LOCK_OFFSET (usually -30)
  // So we need: candle lighting - 30 min = lock time - SHABBAT_LOCK_OFFSET - 30
  const summaryTime = new Date(todaysLockTime.getTime());
  // Undo the lock offset to get candle lighting, then subtract 30 min
  summaryTime.setMinutes(summaryTime.getMinutes() - SHABBAT_LOCK_OFFSET - 30);

  return summaryTime;
}

/**
 * Check if currently Shabbat and lock/unlock groups as needed
 * Called on startup after connection is stable
 * Handles 3 scenarios:
 *   1. Groups locked + still Shabbat → do nothing (reconnect safety)
 *   2. Groups locked + Shabbat ended → UNLOCK groups (catch-up after server was off)
 *   3. Groups not locked + currently Shabbat → LOCK groups (late start)
 */
export async function checkIfCurrentlyShabbat(): Promise<void> {
  if (!SHABBAT_ENABLED) {
    console.log(`[${new Date().toISOString()}] [Shabbat] Shabbat feature disabled, skipping startup check`);
    return;
  }

  const groupsLocked = areGroupsAlreadyLocked();

  // If groups are locked, check if Shabbat is still active or has ended
  if (groupsLocked) {
    if (isCurrentlyShabbat()) {
      // Groups locked + still Shabbat → do nothing (reconnect safety)
      console.log(`[${new Date().toISOString()}] [Shabbat] ✓ Groups locked and Shabbat active - doing NOTHING on reconnect`);
      return;
    }

    // Groups are locked but Shabbat has ended → need to unlock!
    console.log(`[${new Date().toISOString()}] [Shabbat] ⚠️ Groups still locked but Shabbat has ENDED - unlocking NOW...`);
    await unlockGroups(true);
    return;
  }

  console.log(`[${new Date().toISOString()}] [Shabbat] Checking if currently Shabbat...`);

  try {
    // Fetch times from both locations (same as scheduleForToday)
    const [lockData, unlockData] = await Promise.all([
      fetchHebcalTimes(SHABBAT_LOCK_LOCATION),
      fetchHebcalTimes(SHABBAT_UNLOCK_LOCATION),
    ]);

    if (!lockData || !unlockData) {
      console.log(`[${new Date().toISOString()}] [Shabbat] Could not get Shabbat times, skipping startup check`);
      return;
    }

    const now = new Date();

    // Get candle lighting from lock location (Jerusalem)
    const candleLighting = getCandleLightingTime(lockData);
    // Get havdalah from unlock location (Haifa) for actual unlock
    const havdalah = getHavdalahTime(unlockData);

    // Calculate lock and unlock times with offsets
    const lockTime = candleLighting ? applyOffset(candleLighting, SHABBAT_LOCK_OFFSET) : null;
    const unlockTime = havdalah ? applyOffset(havdalah, SHABBAT_UNLOCK_OFFSET) : null;

    console.log(`[${new Date().toISOString()}] [Shabbat] Lock time: ${lockTime?.toISOString() || 'N/A'}`);
    console.log(`[${new Date().toISOString()}] [Shabbat] Unlock time: ${unlockTime?.toISOString() || 'N/A'}`);
    console.log(`[${new Date().toISOString()}] [Shabbat] Current time: ${now.toISOString()}`);

    // Check if we're currently in Shabbat window
    // Case 1: Lock time passed and unlock time is in the future
    if (lockTime && unlockTime && now >= lockTime && now <= unlockTime) {
      console.log(`[${new Date().toISOString()}] [Shabbat] ⚠️ CURRENTLY SHABBAT - groups not locked! Locking NOW...`);

      // Set display times and schedule variables so lockGroups() message works
      if (candleLighting) {
        candleLightingDisplay = formatTime(candleLighting);
      }
      const jerusalemHavdalah = getHavdalahTime(lockData);
      if (jerusalemHavdalah) {
        havdalahDisplay = formatTime(jerusalemHavdalah);
      }
      todaysLockTime = lockTime;
      todaysUnlockTime = unlockTime;

      // Actually lock the groups (skip stability check - we're called from connection handler)
      await lockGroups(true);
      return;
    }

    // Case 2: Only unlock time exists and is in the future (Shabbat started before today)
    if (!lockTime && unlockTime && now <= unlockTime) {
      console.log(`[${new Date().toISOString()}] [Shabbat] ⚠️ CURRENTLY SHABBAT (started before today) - groups not locked! Locking NOW...`);

      // Set display times - candle lighting was yesterday so display may not be available
      todaysUnlockTime = unlockTime;
      const jerusalemHavdalah = getHavdalahTime(lockData);
      if (jerusalemHavdalah) {
        havdalahDisplay = formatTime(jerusalemHavdalah);
      }

      // Actually lock the groups (skip stability check - we're called from connection handler)
      await lockGroups(true);
      return;
    }

    // Not currently Shabbat
    if (lockTime && now < lockTime) {
      console.log(`[${new Date().toISOString()}] [Shabbat] Before Shabbat, groups should be open`);
    } else if (unlockTime && now > unlockTime) {
      console.log(`[${new Date().toISOString()}] [Shabbat] After Shabbat, groups should be open`);
    } else {
      console.log(`[${new Date().toISOString()}] [Shabbat] Not Shabbat, groups should be open`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [Shabbat] Error checking current Shabbat status:`, error);
  }
}

/**
 * Fetch Shabbat times directly (for external use)
 * Used by daily summary to check if it's currently Shabbat
 */
export async function checkShabbatTimes(): Promise<{
  isErevShabbat: boolean;
  isCurrentlyShabbat: boolean;
  summaryTime: Date | null;
}> {
  // If Shabbat locker is disabled, fetch times just for summary scheduling
  if (!SHABBAT_ENABLED) {
    const data = await fetchHebcalTimes(SHABBAT_LOCK_LOCATION);
    if (!data) {
      return { isErevShabbat: false, isCurrentlyShabbat: false, summaryTime: null };
    }

    const candleLighting = getCandleLightingTime(data);
    const havdalah = getHavdalahTime(data);
    const now = new Date();

    // Check if currently Shabbat (havdalah in future, candle lighting passed)
    if (havdalah && havdalah > now) {
      if (!candleLighting || candleLighting < now) {
        return { isErevShabbat: false, isCurrentlyShabbat: true, summaryTime: null };
      }
    }

    // Check if Erev Shabbat
    if (candleLighting && candleLighting > now) {
      const summaryTime = new Date(candleLighting.getTime());
      summaryTime.setMinutes(summaryTime.getMinutes() - 30);
      return { isErevShabbat: true, isCurrentlyShabbat: false, summaryTime };
    }

    return { isErevShabbat: false, isCurrentlyShabbat: false, summaryTime: null };
  }

  // Use cached values from the scheduler
  return {
    isErevShabbat: isErevShabbat(),
    isCurrentlyShabbat: isCurrentlyShabbat(),
    summaryTime: getErevShabbatSummaryTime()
  };
}
