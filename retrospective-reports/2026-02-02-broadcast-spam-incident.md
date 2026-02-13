# Retrospective: WhatsApp Community Broadcast Spam Incident

**Date:** February 2, 2026
**Severity:** Critical
**Impact:** Multiple WhatsApp communities received duplicate messages (up to 5x repetition)
**Resolution Status:** RESOLVED

---

## Executive Summary

### What Happened

Our WhatsApp bot "Logan" experienced a critical incident where it sent duplicate messages to community groups. This included:
- **Daily summaries** sent up to 5 times to the same groups
- **Shabbat lock/unlock messages** repeated on every bot reconnection
- Potential for **infinite message spam** during connection instability

### Business Impact

- Community members received the same messages multiple times
- Trust erosion with community managers
- Potential for WhatsApp account flagging due to spam-like behavior
- User complaints about notification fatigue

### Root Cause (One Sentence)

The bot lacked proper **idempotency protection** - it had no persistent memory of which messages it had already sent, so every reconnection or restart triggered the same broadcasts again.

### Resolution

Implemented a **three-layer protection system**:
1. In-memory locks (prevents concurrent runs)
2. File-based persistence (survives restarts)
3. **Supabase database atomic locks** (survives any failure, prevents race conditions)

### Key Metrics

| Metric | Before | After |
|--------|--------|-------|
| Duplicate messages possible | Unlimited | 0 |
| Reconnection spam | Every reconnect | None |
| Multi-instance race condition | Vulnerable | Protected |
| Recovery from crash | Full resend | Resume where left off |

---

## Timeline of Events and Fixes

### Phase 1: Initial Problem Discovery (Jan 31, 2026)

**Symptoms:**
- Shabbat lock messages sent to groups on every bot reconnection
- During unstable connections, groups received 5+ identical messages

**Commit:** `ccf8cc3` - "fix: Prevent duplicate Shabbat lock messages on reconnects"

**First Attempt:** Added in-memory `Set` to track locked groups:
```typescript
const lockedGroupsThisShabbat = new Set<string>();
// Filter out groups that have already been locked this Shabbat
const groupsToLock = ALLOWED_GROUPS.filter(g => !lockedGroupsThisShabbat.has(g.id));
```

**Problem:** In-memory state is lost on restart/crash.

---

### Phase 2: Silent Lock Attempt (Jan 31, 2026)

**Commit:** `2178512` - "CRITICAL FIX: Stop spamming groups on reconnects during Shabbat"

**Approach:** Created `lockGroupsSilently()` function that locks groups without sending messages on reconnection.

**Problem:** Still performed lock operations on every reconnect, just without messages. Didn't address the core statelessness issue.

---

### Phase 3: File-Based Persistence (Jan 31, 2026)

**Commit:** `d4f7806` - "CRITICAL FIX: File-based lock state persistence"

**Solution:** Persist lock state to `shabbat_lock_state.json`:
```typescript
interface LockState {
  isLocked: boolean;
  lockedAt: string | null;
  unlockScheduledFor: string | null;
}
```

On reconnection during Shabbat:
```typescript
if (areGroupsAlreadyLocked()) {
  console.log('[Shabbat] Groups already locked - doing NOTHING on reconnect');
  return; // Complete exit, no operations at all
}
```

**Improvement:** Groups no longer received duplicate Shabbat messages.

---

### Phase 4: Daily Summary Lock Mechanism (Feb 1, 2026)

**Commit:** `b8a9734` - "fix: Add lock mechanism to prevent duplicate summary requests"

**Problem:** API endpoint could be called multiple times simultaneously, sending duplicate summaries.

**Solution:** In-memory lock per group:
```typescript
const summaryInProgress = new Set<string>();

async function processGroupSummary(groupId: string) {
  if (summaryInProgress.has(groupId)) {
    return false; // Already running
  }
  summaryInProgress.add(groupId);
  try {
    // ... send summary
  } finally {
    summaryInProgress.delete(groupId);
  }
}
```

---

### Phase 5: Persistent Cooldown System (Feb 1, 2026)

**Commit:** `b16a8b4` - "feat: Add persistent cooldown system to prevent summary spam"

**Problem:** Server restarts cleared in-memory locks, allowing duplicate summaries.

**Solution:** File-based cooldown with status tracking:
```typescript
interface SummaryCooldownEntry {
  lastSentAt: number;
  status: 'completed' | 'running' | 'failed';
  startedAt?: number;
  runId?: string;
}
```

**Key Features:**
- 30-minute cooldown between summaries
- Status tracking: `running` → `completed` / `failed`
- Stale detection: If "running" for >10 minutes, consider crashed
- API returns 429 if in cooldown

---

### Phase 6: Supabase Broadcast Guard (Feb 2, 2026)

**Commit:** `8c20bf4` - "feat: Add Supabase-backed broadcast guard"

**Problem:** File-based locks don't work across multiple servers/instances.

**Solution:** Database-backed atomic protection:
```sql
CREATE TABLE broadcast_guard (
  id SERIAL PRIMARY KEY,
  operation_key TEXT NOT NULL,      -- e.g., "daily-summary-2026-02-02"
  broadcast_type TEXT NOT NULL,     -- daily-summary, shabbat-lock, etc.
  status TEXT NOT NULL DEFAULT 'started',
  started_at TIMESTAMP WITH TIME ZONE NOT NULL,
  completed_at TIMESTAMP WITH TIME ZONE,
  run_id TEXT NOT NULL,
  groups_sent TEXT[] DEFAULT '{}',  -- Per-group tracking
  UNIQUE(operation_key, run_id)
);
```

**Key Functions:**
- `canBroadcast()` - Check if operation can proceed
- `markBroadcastStarted()` - Acquire lock
- `markBroadcastCompleted()` / `markBroadcastFailed()` - Release lock
- `recordGroupSent()` - Track per-group progress
- `hasGroupReceived()` - Check if specific group got message

---

### Phase 7: Atomic Lock for Race Conditions (Feb 2, 2026)

**Commit:** `f66b3b6` - "fix: Add atomic lock to prevent race condition with multiple bot instances"

**Problem:** Two bot instances (npm start + PM2) could both pass `canBroadcast()` at the same millisecond and both send messages.

**Root Cause Analysis:**
```
Timeline of race condition:
├─ Process A: canBroadcast() → No existing record → PASS
├─ Process B: canBroadcast() → No existing record → PASS  (same millisecond)
├─ Process A: INSERT status='started' → SUCCESS
├─ Process B: INSERT status='started' → SUCCESS (different run_id!)
└─ RESULT: Both processes send messages → SPAM
```

**Solution:** Partial unique index that allows only ONE "started" record per operation:
```sql
CREATE UNIQUE INDEX idx_broadcast_guard_active_lock
ON broadcast_guard(operation_key)
WHERE status = 'started';
```

**New Flow:**
```
Timeline with atomic lock:
├─ Process A: canBroadcast() → PASS
├─ Process B: canBroadcast() → PASS
├─ Process A: INSERT status='started' → SUCCESS (acquires lock)
├─ Process B: INSERT status='started' → FAIL (unique violation 23505)
└─ RESULT: Only Process A sends messages
```

---

## Technical Deep Dive

### The Core Problem: Stateless Design

The original bot was designed statelessly:
- Each function execution had no memory of previous runs
- Reconnections were treated as fresh starts
- No idempotency keys for broadcast operations

### Why Each Fix Was Necessary

| Layer | Purpose | Survives Restart? | Prevents Race? | Handles Partial Failure? |
|-------|---------|-------------------|----------------|--------------------------|
| In-memory Set | Prevent concurrent same-process runs | No | No | No |
| File-based JSON | Persist across restarts | Yes | No | No |
| Supabase Guard | Cross-instance coordination | Yes | Partial | Yes |
| Partial Unique Index | True atomic locking | Yes | Yes | Yes |

### The Three-Layer Protection Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    INCOMING TRIGGER                          │
│        (Scheduler, API call, Reconnection event)             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  LAYER 1: In-Memory Lock (summaryRunInProgress)             │
│  - Prevents concurrent runs in same process                 │
│  - Fast, no I/O                                             │
│  - Lost on restart                                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  LAYER 2: File-Based Lock (summary-cooldown.json)           │
│  - Persists across restarts                                 │
│  - Cooldown tracking (30 min)                               │
│  - Status: running/completed/failed                         │
│  - Stale detection (>10 min = crashed)                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  LAYER 3: Supabase Broadcast Guard                          │
│  - Database-backed atomic operations                        │
│  - Partial unique index prevents race conditions            │
│  - Per-group tracking for partial failure recovery          │
│  - Cross-instance coordination                              │
│                                                             │
│  Key: INSERT with unique constraint violation = BLOCKED     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    BROADCAST EXECUTION                       │
│  - Iterate through groups                                    │
│  - Check hasGroupReceived() before each                     │
│  - recordGroupSent() after each success                     │
│  - markBroadcastCompleted() in finally block                │
└─────────────────────────────────────────────────────────────┘
```

### Database Schema for Broadcast Guard

```sql
-- Table structure
CREATE TABLE broadcast_guard (
  id SERIAL PRIMARY KEY,
  operation_key TEXT NOT NULL,          -- "daily-summary-2026-02-02"
  broadcast_type TEXT NOT NULL,         -- "daily-summary", "shabbat-lock"
  status TEXT NOT NULL DEFAULT 'started',
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  run_id TEXT NOT NULL,
  groups_sent TEXT[] DEFAULT '{}',      -- ["group1@g.us", "group2@g.us"]
  error_message TEXT
);

-- THE CRITICAL INDEX: Only ONE "started" record per operation_key
CREATE UNIQUE INDEX idx_broadcast_guard_active_lock
ON broadcast_guard(operation_key)
WHERE status = 'started';

-- Standard indexes for queries
CREATE INDEX idx_broadcast_guard_key ON broadcast_guard(operation_key);
CREATE INDEX idx_broadcast_guard_type ON broadcast_guard(broadcast_type);
```

### Code Pattern for Atomic Lock Acquisition

```typescript
export async function markBroadcastStarted(type: BroadcastType): Promise<string | null> {
  const runId = generateRunId();

  const { error } = await supabase
    .from('broadcast_guard')
    .insert({
      operation_key: getOperationKey(type), // "daily-summary-2026-02-02"
      status: 'started',
      run_id: runId
    });

  if (error) {
    // Unique constraint violation = another process has the lock
    if (error.code === '23505') {
      console.log('LOCK BLOCKED: Another process already has lock');
      return null; // BLOCKED - do not proceed
    }
    throw error;
  }

  return runId; // Lock acquired - proceed with broadcast
}
```

---

## Lessons Learned

### 1. Distributed Systems Require Distributed State

**Lesson:** In-memory state is insufficient for any system that can restart, crash, or run multiple instances.

**Application:** Always design with persistence and coordination in mind from the start.

### 2. Idempotency is Non-Negotiable for Broadcast Operations

**Lesson:** Any operation that sends messages to users MUST be idempotent. Users will forgive a missed message but not spam.

**Application:** Use unique operation keys (type + date) and track completion status.

### 3. Race Conditions Require Database-Level Atomicity

**Lesson:** Application-level checks (`if not exists then insert`) are not atomic. The check and insert are separate operations.

**Application:** Use database constraints (unique indexes) to enforce atomicity.

### 4. Partial Failure Must Be Recoverable

**Lesson:** If a broadcast fails midway through (sent to 3 of 5 groups), restarting should not re-send to the first 3.

**Application:** Track per-recipient progress, not just overall status.

### 5. "Silent" is Better Than "Repeated"

**Lesson:** When uncertain, doing nothing is safer than doing something twice.

**Application:** On reconnections, check state first before taking any action.

---

## Preventive Measures Implemented

1. **Atomic Database Locks** - Prevents any race condition
2. **Per-Group Tracking** - Enables partial failure recovery
3. **Stale Detection** - Handles crashed runs (>15 min = stale)
4. **Cooldown Periods** - 30 min for summaries, 12 hours for Shabbat operations
5. **Three-Layer Protection** - Defense in depth
6. **Comprehensive Logging** - Every lock acquisition/release is logged

---

## Monitoring Recommendations

1. **Alert on multiple "LOCK BLOCKED" logs** - Indicates possible misconfiguration
2. **Monitor broadcast_guard table growth** - Clean up old records periodically
3. **Track cooldown rejections** - High numbers may indicate user confusion
4. **Log stale run detections** - May indicate reliability issues

---

## Conclusion

This incident highlighted the importance of designing distributed systems with proper state management from the beginning. The progressive fix approach (in-memory → file-based → database-backed) demonstrated the evolution needed to handle increasingly complex failure modes.

The final solution provides robust protection against:
- Reconnection-triggered duplicate messages
- Restart-triggered duplicate messages
- Multi-instance race conditions
- Partial failure scenarios

The bot now operates with true idempotency - the same trigger will never cause duplicate messages, regardless of how many times it fires or how many instances are running.

---

*Report generated: February 2, 2026*
*Commits analyzed: ccf8cc3 → f66b3b6 (27 commits)*
