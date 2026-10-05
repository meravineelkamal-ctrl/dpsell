# DPSELL — Digital store setup

Shopify-jaisi website: **Google login (Supabase)**, **image/PDF/file/video sell**, **TranzUPI UPI**, **Render webhook**.

API key chat ya GitHub mein **mat** daalo. Purani key leak ho chuki thi — TranzUPI pe **Generate New Key** karo.

---

## 1) Supabase database + storage

1. Open [Supabase project](https://supabase.com/dashboard/project/wyvoumtsyoxhnfzvoavf)
2. Left: **SQL Editor** → New query
3. File `sql/schema.sql` ka poora text paste → **Run**
4. **Authentication → Providers → Google** ON
   - Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client (Web)
   - Authorized redirect URI:
     `https://wyvoumtsyoxhnfzvoavf.supabase.co/auth/v1/callback`
   - Client ID + Secret Supabase Google provider mein paste
5. **Authentication → URL Configuration**
   - Site URL: baad mein Render URL (`https://YOUR-APP.onrender.com`)
   - Redirect URLs: `http://localhost:3000/**` aur `https://YOUR-APP.onrender.com/**`
6. **Project Settings → API**
   - Project URL
   - `anon` `public` key
   - `service_role` key (secret — sirf Render/.env)
7. Ek baar website pe **Google login** karo, phir **Table Editor → profiles**
   - Apni row: `is_admin` = **true**

---

## 2) Local run

```bash
cd c:\Users\merav\Documents\DPSELL
copy .env.example .env
npm install
npm start
```

`.env` mein daalo:

```
SUPABASE_URL=https://wyvoumtsyoxhnfzvoavf.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
TRANZUPI_API_KEY=nayi_key
TRANZUPI_API_BASE=https://www.tranzupi.com/api
PUBLIC_BASE_URL=http://localhost:3000
```

Browser: http://localhost:3000

---

## 3) TranzUPI webhook

1. [API Details](https://www.tranzupi.com/auth/apidetails.php)
2. Nayi API key generate
3. Webhook URL (Render ke baad):

`https://YOUR-APP.onrender.com/webhook`

4. **Update Webhook**

Create-order `user_token` + `/api/create-order` use karta hai (common UPI panel format). Agar TranzUPI docs mein endpoint alag ho to `.env` mein `TRANZUPI_API_BASE` badlo.

---

## 4) Render pe website + webhook

1. Code GitHub pe push (naya repo, jaise `dpsell`)
2. [Render](https://dashboard.render.com/) → **New Web Service** → GitHub repo
3. Build: `npm install` · Start: `npm start`
4. Environment:

| Key | Value |
|-----|--------|
| `SUPABASE_URL` | project URL |
| `SUPABASE_ANON_KEY` | anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role |
| `TRANZUPI_API_KEY` | nai key |
| `TRANZUPI_API_BASE` | `https://www.tranzupi.com/api` |
| `PUBLIC_BASE_URL` | `https://YOUR-APP.onrender.com` |
| `STORE_NAME` | DPSELL |

5. Deploy ke baad TranzUPI webhook **is** URL pe set karo — purana `ff-deploy.onrender.com/webhook` mat use karo (wo doosri app hai).
6. Supabase Auth Site URL ko Render URL se replace karo.

---

## 5) Pehli sale ka flow

1. `/admin.html` → cover + file upload → Publish
2. Home pe product dikhega
3. Buyer Google login → mobile number → **Buy with UPI**
4. Pay → webhook `paid` → `/library.html` se Download

Webhook miss ho to Admin → Orders → **Mark paid**.

---

## Pages

- `/` store
- `/product.html?id=` buy
- `/library.html` downloads
- `/admin.html` products + orders
- `/success.html` payment wait
- `POST /webhook` TranzUPI
- `POST /api/create-order` server-side price
