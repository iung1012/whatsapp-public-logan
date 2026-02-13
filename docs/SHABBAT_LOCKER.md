# Shabbat/Holiday Automatic Group Locker

## Overview

This feature automatically locks WhatsApp groups before Shabbat/holidays and unlocks them after. Groups are set to "announcement mode" (only admins can post) during Shabbat.

## Status: TESTED AND WORKING

**Test Date:** January 29, 2026

### Test Results
- Lock messages sent to all 4 groups
- All 4 groups locked successfully (announcement mode)
- All 4 groups unlocked successfully
- Unlock messages sent to all 4 groups

## Configuration

Environment variables in `.env`:

```env
SHABBAT_ENABLED=true
SHABBAT_LOCK_LOCATION=281184      # Jerusalem (earliest candle lighting)
SHABBAT_UNLOCK_LOCATION=294801    # Haifa (latest havdalah)
SHABBAT_LOCK_OFFSET=-30           # Lock 30 minutes BEFORE candle lighting
SHABBAT_UNLOCK_OFFSET=30          # Unlock 30 minutes AFTER havdalah
```

### Location IDs (Hebcal geonameid)
- Jerusalem: 281184
- Tel Aviv: 293397
- Haifa: 294801

## How It Works

### Daily Schedule (00:05)
1. Fetches Shabbat/holiday times from Hebcal API
2. Gets candle lighting time from LOCK_LOCATION (Jerusalem - earliest)
3. Gets havdalah time from UNLOCK_LOCATION (Haifa - latest)
4. Schedules lock/unlock actions with offsets

### Lock Flow (Before Shabbat)
1. Send message to each group:
   ```
   קהילה יקרה, נועל לדיונים עד מוצ"ש.
   🕯️ כניסת שבת והדלקת נרות: {time}
   ✨ יציאת השבת: {time}
   שבת שלום!
   ```
2. Wait 3 seconds
3. Lock the group (announcement mode)
4. Wait 5 seconds before next group

### Unlock Flow (After Shabbat)
1. Unlock the group (not_announcement mode)
2. Wait 2 seconds
3. Send message:
   ```
   קהילה יקרה, פותח חזרה לדיונים. שבוע טוב!
   ```
4. Wait 5 seconds before next group

## Monitored Groups

Configure your groups via the `ALLOWED_GROUPS` environment variable (JSON array).

Example:
```json
[
  {"id":"120363XXXXXXXXXX@g.us","name":"Group 1"},
  {"id":"120363YYYYYYYYYY@g.us","name":"Group 2"}
]
```

## API Endpoints

### Check Status
```
GET /api/shabbat
```
Returns:
```json
{
  "enabled": true,
  "scheduledLock": "2026-01-31T14:02:00.000Z",
  "scheduledUnlock": "2026-02-01T18:15:00.000Z",
  "candleLighting": "16:32",
  "havdalah": "17:45",
  "groups": [...]
}
```

### Manual Lock
```
POST /api/group-lock
Body: { "groupId": "YOUR_GROUP_ID@g.us" }
```

### Manual Unlock
```
POST /api/group-unlock
Body: { "groupId": "YOUR_GROUP_ID@g.us" }
```

## Edge Cases Handled

1. **Two-day holidays** (Rosh Hashanah, first days of Sukkot/Pesach, Shavuot)
   - Takes the latest havdalah time for unlock

2. **No candle lighting today**
   - Skips lock scheduling
   - Still checks for unlock if Shabbat started yesterday

3. **API failures**
   - Retries in 1 hour

4. **WhatsApp disconnection**
   - Operations fail gracefully with error logging
   - Will work on next scheduled attempt after reconnection

## Logs

All Shabbat-related logs are prefixed with `[Shabbat]`:

```
[Shabbat] Service ENABLED
[Shabbat] Lock location: Jerusalem
[Shabbat] Unlock location: Haifa
[Shabbat] Candle lighting: 31.1.2026, 16:32 (16:32)
[Shabbat] Havdalah (Jerusalem): 1.2.2026, 17:45 (17:45)
[Shabbat] Scheduled LOCK for: 31.1.2026, 16:02 (offset: -30 min)
[Shabbat] Scheduled UNLOCK for: 1.2.2026, 18:15 (offset: +30 min)
```

## Files

- `src/shabbatLocker.ts` - Main service implementation
- `src/api.ts` - API endpoints for manual lock/unlock
- `src/index.ts` - Service initialization

## Requirements

- Bot must be **admin** in all monitored groups
- WhatsApp connection must be stable
- Internet access for Hebcal API

## Troubleshooting

### Groups not locking
1. Check if bot is admin in the group
2. Check logs for `[Shabbat]` errors
3. Verify `SHABBAT_ENABLED=true` in .env

### Wrong times
1. Check SHABBAT_LOCK_LOCATION and SHABBAT_UNLOCK_LOCATION
2. Verify offsets are correct (negative for before, positive for after)

### Manual test
Use `/api/test-lock/:groupId` to test lock/unlock permissions on a single group.
