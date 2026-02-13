# Logan White Label - מדריך הקמת לקוח חדש

## סקירה כללית

כל לקוח מקבל instance נפרד ומבודד של Logan:
לקוח A → Logan Instance A → Supabase A → VPS A
לקוח B → Logan Instance B → Supabase B → VPS B

**יתרונות:**
- בידוד מלא בין לקוחות
- לקוח יכול לקבל שליטה מלאה אם רוצה
- בעיה אצל לקוח אחד לא משפיעה על אחרים
- קל לתמחר ולנהל

---

## שלב 1: איסוף מידע מהלקוח

### פרטים בסיסיים
- [ ] שם העסק/ארגון
- [ ] איש קשר + טלפון + מייל
- [ ] מספר WhatsApp ייעודי לבוט (לא אישי!)

### התאמה אישית
- [ ] שם הבוט (במקום "Logan")
- [ ] אישיות/טון: עברית? אנגלית? רשמי? חברי? שנון?
- [ ] מידע על העסק שהבוט צריך לדעת:
  - מה העסק עושה
  - שירותים/מוצרים
  - שעות פעילות
  - אתר, רשתות חברתיות
  - מחירים (אם רלוונטי)
  - שאלות נפוצות
- [ ] על מה הבוט לא עונה / מפנה לאדם אמיתי

### קבוצות
- [ ] רשימת קבוצות לניטור (שמות)
- [ ] האם הבוט צריך להיות אדמין?

### פיצ'רים
| פיצ'ר | רוצה? | הערות |
|-------|-------|-------|
| תגובה לתיוגים | כן/לא | |
| הודעות קוליות | כן/לא | |
| סיכום יומי (טקסט) | כן/לא | שעה: ___ |
| סיכום יומי (קולי) | כן/לא | |
| נעילת שבת/חג | כן/לא | עיר: ___ |
| זיהוי ספאם | כן/לא | |
| Broadcast API | כן/לא | |

---

## שלב 2: הקמת תשתית

### 2.1 VPS
יצירת שרת חדש:
- **DigitalOcean / Linode / Vultr** - $5-10/חודש
- Ubuntu 22.04 LTS
- 1GB RAM מספיק
- Node.js 18+
```bash
# התקנות בסיסיות
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs git
sudo npm install -g pm2
```

### 2.2 Supabase
1. היכנס ל-supabase.com
2. צור project חדש בשם: `logan-{client-name}`
3. הרץ את ה-SQL:
```sql
CREATE TABLE whatsapp_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  chat_id TEXT NOT NULL,
  chat_name TEXT,
  sender_name TEXT,
  sender_number TEXT,
  message_type TEXT,
  body TEXT,
  timestamp BIGINT,
  from_me BOOLEAN DEFAULT false,
  is_group BOOLEAN DEFAULT false,
  is_content BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_chat_id ON whatsapp_messages(chat_id);
CREATE INDEX idx_created_at ON whatsapp_messages(created_at);
CREATE INDEX idx_sender_number ON whatsapp_messages(sender_number);
```

4. שמור את SUPABASE_URL ו-SUPABASE_KEY

### 2.3 API Keys
צור מפתחות חדשים (או השתמש במשותפים):

| שירות | לינק | הערה |
|--------|------|------|
| Groq | console.groq.com | Free tier נדיב |
| Anthropic | console.anthropic.com | צריך תשלום |
| ElevenLabs | elevenlabs.io | Free tier מוגבל |

---

## שלב 3: Clone והתקנה
```bash
# ב-VPS של הלקוח
cd /home
git clone [your-logan-repo] logan-{client-name}
cd logan-{client-name}
npm install
cp .env.example .env
```

---

## שלב 4: התאמה אישית

### 4.1 עדכון System Prompt
ערוך `src/prompts/logan.ts`:
```typescript
export const BOT_SYSTEM_PROMPT = `
You are {BOT_NAME}, the AI Assistant of {BUSINESS_NAME}.

{BUSINESS_DESCRIPTION}

Contact info:
- Website: {WEBSITE}
- Email: {EMAIL}
- Phone: {PHONE}

{CUSTOM_INSTRUCTIONS}

Important: respond in {LANGUAGE}, max 520 characters.
`;
```

### 4.2 עדכון הודעות שבת (אם רלוונטי)
ערוך `src/features/shabbat.ts`:
- הודעת נעילה
- הודעת פתיחה

### 4.3 עדכון הודעות סיכום
ערוך `src/prompts/daily-summary.ts` ו-`daily-summary-voice.ts`

---

## שלב 5: הגדרת Environment

ערוך `.env`:
```env
# Client: {CLIENT_NAME}
# Created: {DATE}

# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=eyJ...

# APIs
GROQ_API_KEY=gsk_...
ANTHROPIC_API_KEY=sk-ant-...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=3JZUpoTOGG7akwuTH0DK

# Bot
API_PORT=7700
API_KEY={GENERATE_SECURE_KEY}
BOT_PHONE_NUMBERS={CLIENT_PHONE}

# Groups (fill after first connection)
MONITORED_GROUPS=

# Features
DAILY_SUMMARY_ENABLED={true/false}
DAILY_SUMMARY_TIME={HH:MM}
SHABBAT_ENABLED={true/false}
SPAM_DETECTION_ENABLED={true/false}

# Shabbat (get geonameid from geonames.org)
SHABBAT_LOCK_LOCATION={GEONAMEID}
SHABBAT_UNLOCK_LOCATION={GEONAMEID}
SHABBAT_LOCK_OFFSET=-30
SHABBAT_UNLOCK_OFFSET=30

# Whitelist
SPAM_WHITELIST={CLIENT_PHONE},{ADMIN_PHONES}
```

---

## שלב 6: הפעלה ראשונית
```bash
# הפעלה ראשונה לקבלת QR
npm start
```

1. שלח ללקוח את ה-QR (screenshot או terminal share)
2. הלקוח סורק עם WhatsApp
3. חכה ל-"Connected!"
4. שלח הודעה בקבוצה כדי לקבל את ה-Group ID
5. עדכן MONITORED_GROUPS ב-.env
6. הפעל מחדש

---

## שלב 7: הגדרת PM2
```bash
# הפעלה עם PM2
pm2 start npm --name "logan-{client}" -- start
pm2 save
pm2 startup

# בדיקת סטטוס
pm2 status
pm2 logs logan-{client}
```

---

## שלב 8: בדיקות

| בדיקה | פעולה | תוצאה צפויה |
|-------|-------|-------------|
| Health | `curl localhost:7700/api/health` | `{"status":"connected"}` |
| תיוג | תייג את הבוט בקבוצה | תגובה מהבוט |
| הודעה קולית | שלח קולית בפרטי | תמלול + תגובה |
| סיכום | `curl localhost:7700/api/test-daily-summary` | סיכום נשלח |
| Broadcast | שלח POST ל-/api/broadcast | הודעה בכל הקבוצות |

---

## שלב 9: הדרכת לקוח

### מה לתת ללקוח:
- [ ] API Key לשליחת broadcasts
- [ ] URL של ה-API (אם חשוף)
- [ ] מדריך שימוש בסיסי
- [ ] פרטי קשר לתמיכה

### מה ללמד:
- איך לשלוח broadcast (אם רלוונטי)
- מה הבוט עושה ומה לא
- למי לפנות אם יש בעיה
- מה לעשות אם הבוט לא מגיב

---

## שלב 10: Monitoring

### הגדרת התראות
```bash
# UptimeRobot / Better Uptime
# Monitor: http://{IP}:7700/api/health
# Alert: Email / Telegram / SMS
```

### בדיקה יומית
```bash
pm2 status
pm2 logs logan-{client} --lines 50
```

---

## תחזוקה שוטפת

### עדכון גרסה
```bash
cd /home/logan-{client}
git pull
npm install
pm2 restart logan-{client}
```

### החלפת מספר
ראה: [docs/phone-change.md](phone-change.md)

### גיבוי
- Supabase מגבה אוטומטית
- שמור עותק של .env ו-prompts מותאמים

---

## תמחור מוצע

### עלויות שלך (לכל לקוח)
| רכיב | עלות חודשית |
|------|-------------|
| VPS | $5-10 |
| Supabase | $0 (free tier) |
| Groq | $0-10 |
| Claude | $5-15 |
| ElevenLabs | $5-20 |
| **סה"כ** | **$15-55** |

### תמחור ללקוח
| חבילה | מחיר | כולל |
|-------|------|------|
| Basic | 299 ₪/חודש | תגובות + סיכום טקסט |
| Pro | 449 ₪/חודש | + סיכום קולי + שבת |
| Enterprise | 699 ₪/חודש | + התאמה מלאה + SLA |

### הקמה חד פעמית
| פריט | מחיר |
|------|------|
| Setup | 500-1000 ₪ |
| התאמת אישיות | 300-500 ₪ |
| הדרכה | 200-400 ₪ |

---

## צ'קליסט סיום

- [ ] VPS רץ ויציב
- [ ] PM2 מוגדר עם startup
- [ ] כל הבדיקות עברו
- [ ] Monitoring מוגדר
- [ ] לקוח קיבל הדרכה
- [ ] תיעוד ספציפי ללקוח (prompts, .env backup)
- [ ] חשבונית/הסכם נשלח

---

## תבנית מעקב לקוחות

| לקוח | מספר בוט | VPS IP | Status | תשלום |
|------|----------|--------|--------|-------|
| עסק א | 972-50-XXX | 1.2.3.4 | ✅ Active | 01/02 |
| עסק ב | 972-52-XXX | 5.6.7.8 | ✅ Active | 15/02 |
