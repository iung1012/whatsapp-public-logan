# Lessons Learned - Logan WhatsApp Bot

## Shabbat Protection System (February 2026)

### The Incident
During Shabbat, Logan continued sending AI responses to all groups for the entire duration of Shabbat. The bot was supposed to lock groups (set to announcement-only) and go silent, but multiple bugs allowed messages to leak through.

### Root Causes & Fixes

#### Bug 1: `checkIfCurrentlyShabbat()` didn't actually lock groups
**Symptom**: Function detected Shabbat on startup but only logged a warning and returned.
**Fix**: Changed to call `lockGroups(true)` with `skipStabilityCheck` flag when Shabbat is detected.

#### Bug 2: 6 unguarded message-sending paths
**Symptom**: Even when groups were locked, Logan could still send messages through paths that didn't check Shabbat status.
**Paths that were unguarded**:
1. `autoLikePopularMessages()` - sending reactions during Shabbat
2. `processPendingResponses()` - delivering delayed messages during Shabbat
3. `sendBroadcast()` - broadcast messages
4. `/api/send-message` endpoint
5. `/api/send-to-all-groups` endpoint (including TTS)
6. Queue processor `processQueue()`

**Fix**: Added `isCurrentlyShabbat() || areGroupsAlreadyLocked()` checks to all 6 paths.

#### Bug 3: 440 errors killed connection before Shabbat check
**Symptom**: Connection opened, but 440 "Session Replaced" error killed it in 4-5 seconds. The 10-second stability timer never fired, so `checkIfCurrentlyShabbat()` never ran.
**Root cause**: Multiple instances of whatsapp-logger were running simultaneously (ts-node, dist/index.js, PM2).
**Fix**:
- Added 3-second early Shabbat check in `connection.ts` (runs before the 10s stability timer)
- Conservative WebSocket settings (`markOnlineOnConnect: false`, `fireInitQueries: false`)
- Killed all duplicate processes

#### Bug 4: Race condition - `scheduleForToday()` wiped cached times
**Symptom**: Groups stayed locked after Shabbat ended. `checkIfCurrentlyShabbat()` said "still Shabbat" even though havdalah had passed.
**Root cause**: `scheduleForToday()` cleared `todaysLockTime` and `todaysUnlockTime` to `null` **before** the async Hebcal API fetch. During the fetch, the cached values were gone, causing `isCurrentlyShabbat()` to fall through to the timezone fallback.
**Fix**: Don't clear cached values until the API fetch succeeds. If the API fails, keep the cached values intact.

#### Bug 5: `todaysUnlockTime` not set when havdalah passed
**Symptom**: On Saturday evening after havdalah, `isCurrentlyShabbat()` returned `true` because `todaysUnlockTime` was never set (only set when the time was in the future).
**Root cause**: `scheduleForToday()` only set `todaysUnlockTime` inside an `if (unlockTime > now)` block. When havdalah had already passed, the variable stayed `null`, and `isCurrentlyShabbat()` fell to the timezone fallback which extends to 20:30 Israel time.
**Fix**: Always set `todaysUnlockTime` when havdalah is known, even if the time has passed. This lets `isCurrentlyShabbat()` correctly determine Shabbat has ended.

#### Bug 6: Broadcast guard blocked unlock without clearing lock state
**Symptom**: If the Supabase broadcast guard blocked `unlockGroups()` (e.g., another process already unlocked), the function returned without clearing `shabbat_lock_state.json`. Groups appeared "stuck locked" forever.
**Fix**: When the broadcast guard blocks:
- `lockGroups()`: Write lock state to file (groups are actually locked by another process)
- `unlockGroups()`: Clear lock state file (groups are actually unlocked by another process)

---

### Architecture: 4 Layers of Shabbat Detection

| Layer | Source | Availability | Accuracy |
|-------|--------|-------------|----------|
| 1. Hebcal API | Async fetch | Requires internet | Exact times per city |
| 2. Cache file | `shabbat_times_cache.json` | Survives restarts | Exact (from last API fetch, <48h) |
| 3. Lock state file | `shabbat_lock_state.json` | Survives restarts | Binary (locked/not locked) |
| 4. Timezone fallback | `isLikelyShabbatByTimezone()` | Always available | Conservative (Fri 15:30 - Sat 20:30 Israel) |

### Architecture: All 11 Message-Sending Paths (Audited)

| # | Path | File | Guard |
|---|------|------|-------|
| 1 | `handleMention()` | mention-response.ts | `isCurrentlyShabbat() \|\| areGroupsAlreadyLocked()` |
| 2 | `handleVoiceMention()` | mention-response.ts | `isCurrentlyShabbat() \|\| areGroupsAlreadyLocked()` |
| 3 | `autoLikePopularMessages()` | mention-response.ts | `isCurrentlyShabbat() \|\| areGroupsAlreadyLocked()` |
| 4 | `processPendingResponses()` | mention-response.ts | `isCurrentlyShabbat() \|\| areGroupsAlreadyLocked()` |
| 5 | `sendBroadcast()` | broadcast.ts | `isCurrentlyShabbat() \|\| areGroupsAlreadyLocked()` |
| 6 | `/api/send-message` | api.ts | Returns 403 during Shabbat |
| 7 | `/api/send-to-all-groups` + TTS | api.ts | Returns 403 during Shabbat |
| 8 | Queue processor `processQueue()` | api.ts | Blocks queued messages during Shabbat |
| 9 | `lockGroups()` / `unlockGroups()` | shabbatLocker.ts | These ARE the Shabbat messages (OK) |
| 10 | `deleteMessage()` | spamDetector.ts | Deletes spam only (OK during Shabbat) |
| 11 | Daily summary | daily-summary.ts | Has own Shabbat check via `checkShabbatTimes()` |

### Architecture: 3 Startup Scenarios

When the bot starts/reconnects, `checkIfCurrentlyShabbat()` handles:

1. **Groups locked + Shabbat active** -> Do nothing (safe reconnect)
2. **Groups locked + Shabbat ended** -> Unlock groups + send "שבוע טוב"
3. **Groups unlocked + Shabbat active** -> Lock groups + send Shabbat message

### Architecture: Broadcast Guard (Anti-Duplicate)

Supabase-backed atomic broadcast guard prevents duplicate lock/unlock messages even with rapid reconnections:
- Date-based operation keys (`shabbat-lock-2026-02-07`)
- 12-hour cooldown after completion
- 15-minute stale timeout for crashed runs
- Per-group tracking (partial sends resume where they left off)

---

### Key Takeaways

1. **Every message-sending path must be audited for Shabbat guards.** It's not enough to lock the groups - the bot can still send messages through API endpoints, pending queues, and auto-reactions.

2. **Race conditions between async operations and cached state are dangerous.** Clearing state before an async fetch creates a window where the state is invalid. Always keep old values until new ones are confirmed.

3. **"Set only if future" is a bug pattern.** When time-based variables are only set for future events, past events become invisible. Always set the variable so downstream code can compare against it.

4. **Multiple running instances cause 440 errors.** WhatsApp only allows one active session. Before starting, always check for and kill existing instances.

5. **Broadcast guards must sync state on block.** If a guard prevents an operation because another process already did it, the local state files must still be updated to reflect reality.

6. **Conservative fallbacks should fail safe, not fail open.** The timezone fallback (Fri 15:30 - Sat 20:30) is deliberately wide. It's better for groups to stay locked 2 hours too long than to allow spam during Shabbat.

---

### Related Commits
- `577b537` - Block Logan responses during Shabbat for extra safety
- `0730ac2` - Prevent 440 session conflicts with conservative WebSocket settings
- `4284451` - Fix checkIfCurrentlyShabbat to actually lock groups on startup
- `6406113` - Bulletproof Shabbat protection with 4 detection layers
- `ec68c72` - Fix post-Shabbat unlock when server starts after havdalah
- `d830f32` - Prevent groups staying locked after Shabbat ends
- `2add2e2` - Sync lock state file when broadcast guard blocks lock/unlock
