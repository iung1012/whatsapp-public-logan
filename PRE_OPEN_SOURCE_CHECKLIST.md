# Pre-Open-Source Checklist

Run through this checklist before publishing your repo publicly.

## 1. Git History Audit

```bash
# Check if .env was ever committed (should be empty)
git log --all --full-history -- .env

# Check for potential secrets in commit messages
git log --all --grep="password\|secret\|key\|token" -i

# Search all files in history for API keys
git grep -E "(gsk_|sk-ant-|AKIA|ghp_)" $(git rev-list --all)

# Check for phone numbers (Israeli format)
git grep -E "972[0-9]{9}" $(git rev-list --all)
```

**Action**: If any secrets found, you'll need to rewrite git history (see below)

## 2. Local Files to Never Commit

Verify these are in `.gitignore`:
- [x] `.env` (contains all API keys)
- [x] `auth_info/` (WhatsApp session credentials)
- [ ] `shabbat_lock_state.json` (harmless but not needed)
- [ ] `shabbat_times_cache.json` (harmless but not needed)
- [ ] `summary-cooldown.json` (if exists)
- [ ] `tmp_broadcast.json` (if exists)
- [ ] `.claude/` directory (your personal agent notes)
- [ ] `nul` (debugging artifact)

## 3. Documentation Review

Check these files for personal information:
- [ ] `README.md` - replace `<your-repo-url>` with actual URL
- [ ] `docs/onboarding.md` - phone numbers are examples (972501234567)
- [ ] `docs/white-label.md` - uses placeholders like `{CLIENT_PHONE}`
- [ ] Remove or sanitize any screenshots with real phone numbers

## 4. Environment Variables Check

All secrets should be in `.env` (not committed) and documented in `.env.example`:
- [x] `SUPABASE_URL` and `SUPABASE_KEY`
- [x] `GROQ_API_KEY`
- [x] `ANTHROPIC_API_KEY`
- [x] `ELEVENLABS_API_KEY`
- [x] `API_KEY` (for your API server)
- [x] `BOT_PHONE_NUMBER`
- [x] `SPAM_WHITELIST`
- [x] `MENTION_WEBHOOK_URL` and `MENTION_API_KEY`

## 5. Code Audit

Search for potential leaks:
```bash
# Search for hardcoded URLs with credentials
grep -r "https://.*:.*@" --include="*.ts" --include="*.js"

# Search for hardcoded phone numbers
grep -rE "972[0-9]{9}" --include="*.ts" --include="*.js" src/

# Search for hardcoded JIDs (WhatsApp IDs)
grep -r "@s.whatsapp.net" --include="*.ts" --include="*.js" src/
```

## 6. Configuration Files

- [ ] Check if Cloudflare tunnel config exists (if so, add to `.gitignore`)
- [ ] Remove any personal `package-lock.json` modifications
- [ ] Clean up `node_modules/` (already in `.gitignore`)

## 7. Database Security

Your Supabase setup:
- [x] Migrations are clean (no personal data)
- [ ] Ensure Supabase RLS policies are documented
- [ ] Include instructions for users to create their own Supabase project
- [ ] Document required Supabase tables/schema

## 8. Update README

Before publishing:
- [ ] Add your actual GitHub repo URL
- [ ] Add badges (license, version, etc.)
- [ ] Consider adding a "Star History" or "Contributors" section
- [ ] Add a "Security" section explaining what users need to keep private

## 9. Choose License

Your `package.json` says `"license": "MIT"` but there's no LICENSE file:
- [ ] Add a `LICENSE` file with MIT license text
- [ ] Or choose another license (Apache 2.0, GPL, etc.)

## 10. Optional: Remove Personal Memory

Your `.claude/` directory contains personal notes:
```bash
# Add to .gitignore if not already there
echo "/.claude/" >> .gitignore
```

---

## If Secrets Found in Git History

If step 1 found secrets, you need to rewrite history:

### Option A: Use BFG Repo-Cleaner (Recommended)
```bash
# Install BFG
# Download from: https://rtyley.github.io/bfg-repo-cleaner/

# Create a fresh clone
git clone --mirror https://github.com/yourusername/whatsapp-logger.git

# Remove .env file from all commits
java -jar bfg.jar --delete-files .env whatsapp-logger.git

# Clean up
cd whatsapp-logger.git
git reflog expire --expire=now --all
git gc --prune=now --aggressive

# Force push (WARNING: destructive)
git push --force
```

### Option B: Use git-filter-repo
```bash
# Install git-filter-repo
pip install git-filter-repo

# Remove .env from history
git filter-repo --invert-paths --path .env

# Force push (WARNING: destructive)
git push --force --all
```

### Option C: Start Fresh (Simplest)
If history is simple and you don't care about preserving it:
```bash
# Delete .git and start fresh
rm -rf .git
git init
git add .
git commit -m "Initial commit - clean history"
git remote add origin <new-repo-url>
git push -u origin master
```

---

## Final Pre-Publish Check

```bash
# Make sure everything is clean
git status

# Check what would be published
git ls-files

# Look for suspicious files
git ls-files | grep -E "\.env$|auth_info|\.pem$|\.key$"
```

## After Publishing

1. **Invalidate ALL API keys** from your `.env` immediately
2. Generate new keys for your local copy
3. Update your Supabase URL if it's specific to your project
4. Consider rotating your WhatsApp session (re-scan QR)

---

## License Template

Create `LICENSE` file:

```
MIT License

Copyright (c) 2024-2026 [Your Name]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
