# 📥 أرسل لنفسي

موقع شخصي ترسل فيه لنفسك **نصوص وصور وملفات وفيديو وصوت** من أي جهاز (جوال أو كمبيوتر).

- ❌ بدون نظام حسابات — كلمة مرور واحدة فقط (الافتراضية: `12345`)
- ⚡ مزامنة لحظية بين كل الأجهزة (SSE)
- 🖼️ مصغّرات تلقائية للصور + بث متدرج (Range) للفيديو والصوت
- 🔁 تغيير كلمة المرور من داخل الموقع في أي وقت

---

## التشغيل محليًا

```bash
npm install
npx drizzle-kit push   # اختياري — الجداول تُنشأ تلقائيًا عند أول طلب
npm run build && npm start
```

المطلوب فقط متغير بيئة واحد:

| المتغير        | الوصف                                    |
| -------------- | ---------------------------------------- |
| `DATABASE_URL` | رابط اتصال PostgreSQL                    |
| `DEFAULT_PASSWORD` | (اختياري) كلمة المرور الافتراضية، الافتراضي `12345` |

---

## ☁️ النشر السحابي (Firebase / Cloud Run / Vercel / أي Serverless)

### 1) قاعدة البيانات — PostgreSQL خارجية

الملفات المحلية والقاعدة المحلية **تُمحى عند إعادة تشغيل** بيئات serverless، لذلك:

1. أنشئ قاعدة مجانية من أحد: **Neon** (`neon.tech`) أو **Supabase** أو **Cloud SQL**
2. انسخ رابط الاتصال وضعه في متغير البيئة:

```env
DATABASE_URL=postgresql://user:pass@host.region.provider/dbname?sslmode=require
```

> ✅ لا حاجة لأي تهيئة يدوية — الجداول (`config`, `items`) تُنشأ تلقائيًا عند أول طلب (`ensureSchema`).
> ✅ الاتصال SSL يُفعَّل تلقائيًا لأي مضيف خارجي.

### 2) تخزين الملفات — MEGA.nz أو S3

بدون متغيرات التخزين يحفظ التطبيق الملفات على القرص المحلي (مناسب لـ VPS دائم فقط، ويُمحى في بيئات serverless).

**الخيار الأول — MEGA.nz (مجاني، ٢٠ جيجا):**

| المتغير         | الوصف                                        |
| --------------- | -------------------------------------------- |
| `MEGA_EMAIL`    | إيميل حساب MEGA (مطلوب)                      |
| `MEGA_PASSWORD` | كلمة مرور الحساب (مطلوبة)                    |
| `MEGA_FOLDER`   | اسم المجلد داخل الحساب — الافتراضي `send-to-self` |

```env
STORAGE_DRIVER=mega
MEGA_EMAIL=you@example.com
MEGA_PASSWORD=your-password
MEGA_FOLDER=send-to-self
```

- الملفات تُحفظ بأسماء مشفّرة (UUIDs) داخل مجلد مخصص في حسابك، وتظهر داخل MEGA بنفس التشفير الطرف-للطرف المعتاد.
- ملاحظة: حساب MEGA المجاني له حد نقل (transfer quota) متغيّر — كافٍ للاستخدام الشخصي عادة.
- نصيحة أمان: الأفضل استخدام حساب MEGA مخصص لهذا الغرض.

**الخيار الثاني — S3 متوافق (AWS / Cloudflare R2 / Firebase-GCS / Supabase / MinIO):**

| المتغير               | الوصف                                              |
| --------------------- | -------------------------------------------------- |
| `S3_BUCKET`           | اسم الحاوية (مطلوب)                                |
| `S3_ACCESS_KEY_ID`    | مفتاح الوصول (مطلوب)                               |
| `S3_SECRET_ACCESS_KEY`| المفتاح السري (مطلوب)                               |
| `S3_REGION`           | المنطقة — الافتراضي `auto`                          |
| `S3_ENDPOINT`         | عنوان مخصص لغير AWS (R2 / GCS / MinIO / Supabase) |
| `S3_PREFIX`           | بادئة المفاتيح — الافتراضي `uploads/`              |
| `STORAGE_DRIVER`      | اختياري: `mega` / `s3` / `local` (تفصيل صريح عند توفّر أكثر من إعداد) |

**أمثلة جاهزة:**

```env
# AWS S3
S3_BUCKET=my-inbox
S3_REGION=me-central-1
S3_ACCESS_KEY_ID=AKIA...
S3_SECRET_ACCESS_KEY=...

# Cloudflare R2
S3_BUCKET=my-inbox
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...

# Firebase Storage (عبر توافق GCS مع S3 — أنشئ HMAC key من إعدادات Cloud Storage)
S3_BUCKET=<project-id>.appspot.com
S3_ENDPOINT=https://storage.googleapis.com
S3_REGION=auto
S3_ACCESS_KEY_ID=<HMAC access key>
S3_SECRET_ACCESS_KEY=<HMAC secret>

# Supabase Storage (S3 endpoint من Project Settings → Storage)
S3_BUCKET=inbox
S3_ENDPOINT=https://<project-ref>.supabase.co/storage/v1/s3
S3_REGION=<project-region>
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

> 🔑 أنشئ HMAC keys في Firebase من:  
> **Google Cloud Console → Cloud Storage → Settings → Interoperability → Access keys**

### 3) النشر على Render (موصى به للخطة المجانية)

1. ارفع الكود إلى مستودع GitHub (حمّل حزمة المصدر الجاهزة من `/api/source` بعد تسجيل الدخول للموقع، أو ادفع الكود مباشرة بأدوات git).
2. في Render: **New → Web Service** واربط المستودع.
3. الإعدادات:
   - **Language:** Node — **Branch:** `main` — **Region:** الأقرب لك
   - **Build Command:** `npm ci && npm run build`
   - **Start Command:** `npm start` (منصة Render تمرّر `PORT` تلقائيًا و`next start` يقرأه)
   - **Instance Type:** Free
4. **Environment Variables:** (كل ما هو مشروح أدناه)
   - `DATABASE_URL` ← من Neon أو Supabase
   - `STORAGE_DRIVER=mega` + `MEGA_EMAIL` + `MEGA_PASSWORD` + `MEGA_FOLDER=send-to-self`
   - `DEFAULT_PASSWORD=كلمة-قوية-من-اختيارك` (تُستخدم لأول تشغيل فقط)
5. بعد أول نشر ناجح:
   - من **Settings → Health Check Path** ضع `/api/health`
   - سجّل في الموقع وغيّر كلمة المرور من الداخل
   - أضِف رابط الموقع إلى **UptimeRobot** (فحص كل ٥ دقائق) لمنع خطة Free من النوم

> ⚠️ القرص المحلي في Render **مؤقت** (يُمسح مع كل إعادة نشر/إقلاع، والـ Free لا يدعم الأقراص الدائمة) — لذلك الملفات على MEGA والقاعدة على PostgreSQL خارجية دائمًا.

---

## الأوامر المتاحة (API)

| الأمر                         | الوصف                                   |
| ----------------------------- | --------------------------------------- |
| `GET /api/health`             | فحص صحة السيرفر وقاعدة البيانات         |
| `POST /api/login`             | دخول بكلمة المرور (كوكي ٣٠ يومًا)        |
| `GET /api/session`            | حالة الجلسة                             |
| `GET /api/events`             | قناة SSE للمزامنة اللحظية               |
| `GET /api/items`              | قائمة العناصر                            |
| `POST /api/upload`            | إرسال نص + ملفات (JSON أو multipart)     |
| `GET /api/file/:id`           | جلب ملف (`?download=1` أو `?thumb=1`)   |
| `DELETE /api/items/:id`       | حذف عنصر                                 |
| `DELETE /api/items`           | مسح الكل                                 |
| `POST /api/change-password`   | تغيير كلمة المرور                       |
