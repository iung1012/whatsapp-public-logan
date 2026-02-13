# Security Guidelines

## Overview

Logan is designed to handle sensitive data including WhatsApp messages, group metadata, and API credentials. This document outlines security best practices for deploying and maintaining Logan.

## Critical Security Requirements

### 1. Environment Variables

**NEVER commit your `.env` file to version control.**

All sensitive credentials must be stored in `.env`:
- `SUPABASE_URL` and `SUPABASE_KEY` - Database access
- `GROQ_API_KEY` - AI model access
- `ANTHROPIC_API_KEY` - Claude API for summaries
- `ELEVENLABS_API_KEY` - Voice synthesis (if used)
- `API_KEY` - Your API server authentication key
- `BOT_PHONE_NUMBER` - Bot's WhatsApp number
- `SPAM_WHITELIST` - Exempt phone numbers

Generate a secure API key:
```bash
openssl rand -hex 32
```

### 2. WhatsApp Session Credentials

The `auth_info/` directory contains your WhatsApp session credentials. **This directory must NEVER be committed or shared.**

- If leaked, anyone can impersonate your bot
- Rotate credentials by deleting `auth_info/` and re-scanning QR
- Back up `auth_info/` securely (encrypted, offline)

### 3. Supabase Security

#### Row Level Security (RLS)

Your Supabase tables should have RLS enabled:

```sql
-- Enable RLS on messages table
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Create policy for authenticated access only
CREATE POLICY "Authenticated users can read messages"
  ON messages FOR SELECT
  USING (auth.role() = 'authenticated');
```

#### API Keys

- Use **anon key** for client-side access (limited permissions)
- Use **service role key** for server-side operations (full permissions)
- Never expose service role key in client code

### 4. API Server Security

Logan includes an API server (`src/api.ts`). **Always enable authentication in production:**

```env
API_KEY=your-secure-random-key-here
```

Without `API_KEY`, anyone can:
- Send messages via your bot
- Access broadcast endpoints
- Trigger operations

### 5. Rate Limiting

Built-in rate limits protect against abuse:
- 3 responses per user per minute
- Groq API: 200K tokens/day (monitor usage)
- WhatsApp: Conservative delays prevent bans

### 6. Spam Detection

When enabling spam detection:
- Whitelist trusted users: `SPAM_WHITELIST=972501234567,972509876543`
- Bot must be admin in groups (to remove spammers)
- Review spam logs regularly

### 7. Database Backups

**Supabase automatic backups:**
- Free tier: Daily backups, 7-day retention
- Pro tier: Point-in-time recovery

**Manual backup:**
```bash
# Export Supabase database
pg_dump -h db.your-project.supabase.co \
  -U postgres -d postgres > backup.sql
```

## Deployment Security

### Local Development
- Keep `.env` in `.gitignore`
- Use test API keys when possible
- Don't share `auth_info/`

### Production Deployment

1. **Rotate all API keys** before deploying
2. **Enable Supabase RLS** policies
3. **Set strong API_KEY** for the API server
4. **Use environment variables** (never hardcode secrets)
5. **Monitor logs** for suspicious activity

### Cloudflare Tunnel (Optional)

If using Cloudflare tunnel for remote access:
- Protect tunnel with Cloudflare Access policies
- Require authentication for sensitive endpoints
- Enable rate limiting

## Data Privacy

### Message Logging

Logan logs all group messages to Supabase:
- **Content**: Full message text and media metadata
- **Metadata**: Sender, timestamp, group ID
- **Retention**: No automatic deletion (implement your own policy)

### GDPR/Privacy Compliance

If operating in EU or with EU users:
- Inform group members about logging
- Provide data deletion mechanisms
- Document data retention policies
- Implement user opt-out

### Sensitive Information

- Don't log messages containing credit cards, passwords, or PII
- Implement content filters if needed
- Consider encrypting sensitive fields in Supabase

## Incident Response

### If API Keys Are Leaked

1. **Immediately rotate all affected keys:**
   - Groq: console.groq.com → API Keys → Revoke
   - Anthropic: console.anthropic.com → API Keys → Delete
   - Supabase: Dashboard → Settings → API → Reset keys
   - ElevenLabs: elevenlabs.io → Profile → Regenerate

2. **Check API usage logs** for unauthorized access
3. **Update `.env`** with new keys
4. **Restart the bot**

### If WhatsApp Session Is Compromised

1. **Delete `auth_info/` directory**
2. **Unlink device** from WhatsApp → Linked Devices
3. **Re-scan QR code** to create new session
4. **Check message logs** for unauthorized messages

### If Database Is Compromised

1. **Rotate Supabase keys immediately**
2. **Review RLS policies**
3. **Check for unauthorized access** in Supabase logs
4. **Audit database contents** for malicious modifications

## Reporting Security Issues

If you discover a security vulnerability:
- **Do NOT open a public GitHub issue**
- Email: [your-security-email@example.com]
- Provide details: affected component, reproduction steps, impact
- Allow 90 days for patching before public disclosure

## Security Checklist

Before deploying to production:
- [ ] All secrets in `.env` (not hardcoded)
- [ ] `.env` and `auth_info/` in `.gitignore`
- [ ] Strong `API_KEY` generated (32+ characters)
- [ ] Supabase RLS policies enabled
- [ ] Rate limiting configured
- [ ] Logs monitored regularly
- [ ] Backup strategy in place
- [ ] Incident response plan documented

## Security Best Practices

1. **Principle of Least Privilege**: Grant minimal necessary permissions
2. **Defense in Depth**: Multiple layers of security (API key + RLS + rate limiting)
3. **Regular Audits**: Review logs, permissions, and access patterns monthly
4. **Keep Dependencies Updated**: `npm audit` and update regularly
5. **Monitor API Usage**: Watch for unusual spikes (potential abuse)

## Dependencies Security

Check for vulnerabilities:
```bash
# Audit npm packages
npm audit

# Fix vulnerabilities
npm audit fix

# Check for outdated packages
npm outdated
```

## Additional Resources

- [Baileys Security](https://github.com/WhiskeySockets/Baileys#security)
- [Supabase Security](https://supabase.com/docs/guides/database/postgres/security)
- [OWASP API Security Top 10](https://owasp.org/www-project-api-security/)
