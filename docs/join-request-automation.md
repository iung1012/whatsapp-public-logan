# Join Request Automation - Documentation

## Overview

Automated system for processing WhatsApp group join requests with intelligent bot detection. Eliminates manual waiting list management by automatically approving real people and rejecting spam bots.

## 🎯 Features

### Automatic Bot Detection
- **Profile Analysis**: No profile picture (+2 points)
- **Phone Pattern Analysis**: Sequential/repeating numbers (+1 point)
- **Mass Join Detection**: Multiple simultaneous requests (+1-2 points)
- **Threshold-Based**: Score ≥ 3 = Bot, auto-reject

### Smart Approval Logic
- ✅ **Auto-approve humans** when group has available slots
- ❌ **Auto-reject bots** based on suspicion score
- ⏳ **Waitlist humans** when group is full
- 🔒 **Whitelist support** - trusted numbers always approved

### Safety & Compliance
- **Admin-only**: Only works in groups where Logan is admin
- **Shabbat/Chag aware**: Respects Jewish holidays (no processing)
- **Capacity management**: Enforces max group size limits
- **Notification system**: DMs admins with daily summaries

## 📋 Configuration

### Environment Variables (.env)

```env
# Enable/disable the feature
AUTO_PROCESS_JOIN_REQUESTS=true

# Bot detection threshold (0-5 scale)
# 3 = balanced (recommended)
# 4 = more aggressive (fewer false positives)
# 2 = more permissive (may miss some bots)
JOIN_REQUEST_BOT_THRESHOLD=3

# Maximum group size (WhatsApp max = 1024)
MAX_GROUP_SIZE=1024

# Daily processing time (24h format, Israel timezone)
JOIN_REQUEST_PROCESS_TIME=09:00

# Admin notification recipients (comma-separated phone numbers)
# Falls back to SPAM_ADMIN_NOTIFY if not set
JOIN_REQUEST_NOTIFY_ADMINS=972501234567,972509876543
```

### Whitelist Configuration

Uses the same whitelist as spam detection:

```env
# Trusted phone numbers (always approved, never rejected)
SPAM_WHITELIST=972501234567,972509876543
```

## 🚀 Usage

### Automatic Daily Processing

Once configured and Logan is promoted to admin in target groups:
- Runs automatically daily at configured time (default: 9 AM Israel time)
- Processes all groups where Logan is admin
- Sends DM summaries to configured admins

### Manual Trigger

Process join requests immediately without waiting for scheduled time:

```bash
npm run manual-join-requests
```

This will:
1. Connect to WhatsApp
2. Process all pending join requests in all groups
3. Generate a detailed JSON report
4. Print summary to console
5. Save report to `reports/join-requests/`

## 📊 Reports & Logging

### Report Structure

Reports are saved as timestamped JSON files in `reports/join-requests/`:

```json
{
  "timestamp": "2026-02-13T10:04:23.601Z",
  "summary": {
    "totalGroups": 6,
    "totalApproved": 3,
    "totalRejected": 2,
    "totalWaitlisted": 1,
    "totalErrors": 0
  },
  "groupResults": [
    {
      "groupName": "וייב קודינג",
      "approved": 2,
      "rejected": 1,
      "waitlisted": 0,
      "errors": [],
      "details": {
        "approvedJids": ["972501234567@s.whatsapp.net", "..."],
        "rejectedJids": ["972509999999@s.whatsapp.net"],
        "waitlistedJids": []
      }
    }
  ]
}
```

### Console Output Example

```
============================================================
PROCESSING COMPLETE - SUMMARY
============================================================
Total Groups Processed: 6
✅ Total Approved: 5
❌ Total Rejected (Bots): 3
⏳ Total Waitlisted: 2
⚠️  Total Errors: 0

Detailed Results by Group:
------------------------------------------------------------

📱 וייב קודינג
   ✅ Approved: 2
      - +972501234567
      - +972508765432
   ❌ Rejected: 1
      - +972509999999
```

### Admin Notifications

Admins receive DM summaries in Hebrew:

```
🤖 סיכום בקשות הצטרפות - וייב קודינג

✅ אושרו: 5 אנשים
❌ נדחו (בוטים): 3 חשבונות
⏳ בהמתנה (קבוצה מלאה): 2 אנשים

נדחו:
❌ +972-50-111-1111
❌ +972-50-222-2222
❌ +972-50-333-3333
```

## 🔧 Troubleshooting

### "Bot is not admin" Error

**Cause**: Logan is not an admin in the group

**Solution**: Promote Logan to admin in the group settings
- Go to Group Info → Participants
- Find Logan (972559507005)
- Tap → Make Group Admin

### No Pending Requests

**Normal behavior** when:
- All requests already processed
- Group has approval disabled
- No one has requested to join recently

### Requests Not Being Processed

Check:
1. `AUTO_PROCESS_JOIN_REQUESTS=true` in .env
2. Logan is admin in the target groups
3. It's not Shabbat/Chag (processing is disabled during holidays)
4. Scheduled time has passed (or use manual trigger)

### False Positives (Real People Rejected)

If legitimate users are being rejected as bots:
- Lower `JOIN_REQUEST_BOT_THRESHOLD` to 4 (more conservative)
- Add their numbers to `SPAM_WHITELIST`
- Check if they have profile pictures set

### False Negatives (Bots Getting Approved)

If bots are getting through:
- Lower `JOIN_REQUEST_BOT_THRESHOLD` to 2 (more aggressive)
- Review bot patterns in recent reports
- Consider adding more phone pattern detection rules

## 🏗️ Architecture

### Components

1. **botDetection.ts**: Scoring algorithm
   - Profile picture analysis
   - Phone number pattern matching
   - Mass join detection

2. **joinRequestProcessor.ts**: Core logic
   - Fetch pending requests via Baileys API
   - Calculate bot scores
   - Execute approve/reject actions
   - Handle group capacity
   - Send notifications

3. **join-request-scheduler.ts**: Scheduling
   - Daily scheduled runs
   - Shabbat/Chag awareness
   - Manual trigger support

4. **Integration points**:
   - index.ts: Lifecycle management
   - config.ts: Configuration constants
   - messageHandler.ts: Startup logging

### Flow Diagram

```
┌─────────────────┐
│  Scheduled Time │
│   (9 AM daily)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐      No      ┌──────────────┐
│ Check Shabbat/  │─────────────▶│ Skip & Wait  │
│     Chag        │              └──────────────┘
└────────┬────────┘
         │ Yes (OK to run)
         ▼
┌─────────────────┐
│ For each group  │
│ where bot is    │
│     admin       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Fetch pending   │
│ join requests   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Calculate bot   │
│ scores for each │
└────────┬────────┘
         │
         ├─────────▶ Score ≥ 3 ──────▶ Reject (Bot)
         │
         ├─────────▶ Score < 3 ──┬───▶ Approve (if room)
         │                       │
         │                       └───▶ Waitlist (if full)
         │
         ▼
┌─────────────────┐
│ Send DM report  │
│   to admins     │
└─────────────────┘
```

## 📈 Monitoring & Maintenance

### Daily Checks

Review the DM notifications you receive:
- Are the right people being approved?
- Are bots being caught effectively?
- Any suspicious patterns emerging?

### Weekly Review

Check the reports in `reports/join-requests/`:
- Analyze rejection reasons
- Look for false positive patterns
- Adjust threshold if needed

### Monthly Audit

- Review whitelist - remove old numbers if needed
- Check group admin status - ensure Logan still has permissions
- Verify bot detection accuracy

## 🔐 Security Considerations

### Admin Permission Required

The feature **only works in groups where Logan is admin** for security:
- Prevents unauthorized group modifications
- Ensures bot is authorized to manage members
- Follows principle of least privilege

### Whitelist Protection

Whitelisted numbers **bypass all checks**:
- Use only for trusted community members
- Review whitelist periodically
- Remove inactive numbers

### Audit Trail

All actions are logged:
- Timestamped JSON reports
- Full JID/phone number records
- Reason codes for rejections
- Error tracking

## 🎓 Best Practices

### Initial Setup

1. Start with threshold = 3 (balanced)
2. Monitor first week closely
3. Adjust based on false positive/negative rates
4. Build whitelist gradually

### Group Management

- Make Logan admin only in groups you actively manage
- Review group capacity settings regularly
- Keep admin notification numbers up to date

### Threshold Tuning

| Threshold | Behavior | Use Case |
|-----------|----------|----------|
| 2 | Very aggressive, few false negatives | High spam attack periods |
| 3 | Balanced (recommended) | Normal operation |
| 4 | Conservative, fewer false positives | Sensitive communities |

### Whitelist Maintenance

- Add VIPs and trusted community leaders
- Remove users who leave communities
- Don't over-rely on whitelist - bot detection should be primary

## 📚 Related Documentation

- [Spam Detection](../src/spamDetector.ts) - Message-based spam filtering
- [Shabbat Protection](./shabbat-protection.md) - Holiday awareness system
- [Bot Detection Algorithm](../src/utils/botDetection.ts) - Scoring implementation

## 🆘 Support

If you encounter issues:
1. Check troubleshooting section above
2. Review recent reports in `reports/join-requests/`
3. Run manual trigger to test immediately: `npm run manual-join-requests`
4. Check logs for error messages
5. Verify .env configuration

---

**Last Updated**: 2026-02-13
**Feature Version**: 1.0.0
**Status**: Production Ready ✅
