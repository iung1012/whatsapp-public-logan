# Phone Number Change Guide

This guide explains how to change Logan's WhatsApp phone number when needed.

## When Is This Needed?

- **WhatsApp Ban**: Your number was banned or restricted by WhatsApp
- **New Number**: Switching to a different phone number
- **Account Issues**: Session expired or authentication problems
- **Testing**: Setting up a test instance with a different number

## What You'll Need

- Access to the new WhatsApp number (phone with WhatsApp installed)
- SSH/terminal access to the Logan server
- Admin access to all monitored WhatsApp groups

---

## Step-by-Step Instructions

### Step 1: Stop Logan

Stop the running Logan instance:

```bash
# If using PM2
pm2 stop logan

# If using systemd
sudo systemctl stop logan

# If running directly
# Press Ctrl+C in the terminal
```

### Step 2: Delete Authentication Folder

Remove the existing WhatsApp session:

```bash
cd /path/to/logan
rm -rf auth_info_baileys
```

> **Warning**: This logs out the current WhatsApp session. The old number will no longer be connected to Logan.

### Step 3: Update Environment Variables

Edit your `.env` file:

```bash
nano .env
```

Update the following:

```env
# Update to new phone number (without + or leading zeros)
BOT_PHONE_NUMBER=972501234567

# If the old number was in the whitelist, update it
SPAM_WHITELIST=972501234567,other_numbers_here
```

### Step 4: Restart Logan

Start Logan to generate a new QR code:

```bash
# If using PM2
pm2 start logan

# If using systemd
sudo systemctl start logan

# If running directly
npm start
```

### Step 5: Scan New QR Code

1. Watch the terminal for the QR code to appear
2. Open WhatsApp on the **new phone number**
3. Go to **Settings > Linked Devices > Link a Device**
4. Scan the QR code displayed in the terminal
5. Wait for "Connected!" message in the logs

### Step 6: Add New Number as Admin

For Shabbat locking and spam removal to work, the bot must be admin in each group:

1. Open each monitored WhatsApp group
2. Go to **Group Info**
3. Find the new bot number in the participants list
4. Long press on the number
5. Select **"Make group admin"**

Repeat for all monitored groups.

### Step 7: Verify Everything Works

Test the new setup:

```bash
# Check health
curl http://localhost:7700/api/health

# Test mention response
# Tag the bot in a group message

# Test admin permissions
curl http://localhost:7700/api/test-shabbat-lock
# (This will lock all groups - unlock immediately after)
curl http://localhost:7700/api/test-shabbat-unlock
```

---

## What Is Preserved

| Data | Status |
|------|--------|
| Message history in Supabase | Preserved |
| Group configurations | Preserved |
| API keys and settings | Preserved |
| Prompt customizations | Preserved |

## What Needs Manual Update

| Item | Action Required |
|------|-----------------|
| WhatsApp session | Re-scan QR code |
| Group admin status | Add new number as admin in each group |
| `.env` BOT_PHONE_NUMBER | Update to new number |
| `.env` SPAM_WHITELIST | Update if old number was listed |
| External integrations | Update any webhooks pointing to old number |

---

## Troubleshooting

### QR Code Not Appearing

```bash
# Ensure auth folder is deleted
ls -la auth_info_baileys
# Should show "No such file or directory"

# Restart Logan
pm2 restart logan
```

### "Connection Closed" Errors After Scan

- Wait 30-60 seconds for connection to stabilize
- If persistent, delete auth folder and try again
- Ensure no other devices are linked to the same WhatsApp number

### Bot Not Responding to Mentions

- Verify `BOT_PHONE_NUMBER` in `.env` matches the new number
- Check that the number format is correct (no + or leading zeros)
- Example: `972501234567` not `+972-50-123-4567`

### Shabbat Lock Not Working

- Confirm bot is admin in the group
- Test with: `curl http://localhost:7700/api/test-lock/GROUP_ID_HERE`
- Check logs for permission errors

---

## Quick Reference

```bash
# Complete phone change process
pm2 stop logan
rm -rf auth_info_baileys
nano .env  # Update BOT_PHONE_NUMBER
pm2 start logan
# Scan QR code with new phone
# Add as admin in all groups
```

---

## Related Documentation

- [Onboarding Guide](onboarding.md) - Full setup instructions
- [README](../README.md) - Project overview
