# WhatsApp Gateway (wa-gateway-tsany)

Gateway WhatsApp multi-tenant berbasis Node.js/TypeScript dengan **REST API** dan **dashboard web** untuk otomasi nomor pribadi (self-hosted). Satu proses dapat mengelola banyak tenant dan banyak sesi WhatsApp, lengkap dengan login dashboard, API key, koneksi QR/pairing, antrean pengiriman, riwayat pesan, media, webhook, serta analisa isi pesan dan statistik operasional.

> **Peringatan penting:** proyek ini memakai protokol WhatsApp Web yang **tidak resmi** (Baileys). Tidak ada jaminan kompatibilitas/SLA dan ada risiko nomor diblokir. Gunakan nomor khusus otomasi, bukan nomor utama, dan patuhi ketentuan WhatsApp yang berlaku.

## Daftar isi

- [Laporan End-to-End](#laporan-end-to-end)
  - [Tujuan dan ruang lingkup](#tujuan-dan-ruang-lingkup)
  - [Arsitektur](#arsitektur)
  - [Komponen utama](#komponen-utama)
  - [Alur end-to-end](#alur-end-to-end)
  - [Model data dan penyimpanan](#model-data-dan-penyimpanan)
  - [Keamanan](#keamanan-end-to-end)
  - [Pengujian dan status](#pengujian-dan-status)
  - [Batasan](#batasan)
- [Snapshot Dashboard](#snapshot-dashboard)
- [Cara Instalasi](#cara-instalasi)
  - [Prasyarat](#prasyarat)
  - [Instalasi lokal (development/production)](#instalasi-lokal-developmentproduction)
  - [Menjalankan dengan Docker](#menjalankan-dengan-docker)
  - [Verifikasi instalasi](#verifikasi-instalasi)
- [Dashboard Web](#dashboard-web)
- [Referensi API](#referensi-api)
- [Contoh JavaScript](#contoh-javascript)
- [Contoh PHP](#contoh-php)
- [Webhook](#webhook)
- [Analisa dan statistik](#analisa-dan-statistik)
- [Media dan Retensi](#media-dan-retensi)
- [Konfigurasi](#konfigurasi)
- [Operasional](#operasional)

---

## Laporan End-to-End

### Tujuan dan ruang lingkup

Tujuan: menyediakan gateway WhatsApp self-hosted yang bisa diintegrasikan dari aplikasi JavaScript/PHP lewat REST, sekaligus dikelola tenant secara mandiri lewat dashboard.

Cakupan yang diimplementasikan:
- **Multi-tenant & multi-nomor**: isolasi data per tenant (`tenants` → `api_keys`/`users` → `sessions` → `messages`/`media`).
- **Akses**: login dashboard (email/password, cookie sesi) dan API key Bearer (`wag_...`) untuk integrasi.
- **Koneksi WhatsApp**: sesi per nomor via Baileys, login QR atau pairing code, pemulihan sesi saat startup.
- **Pengiriman**: teks, gambar, video (URL/upload), serta pesan interaktif tombol (native flow) dan daftar (`ListMessage` klasik) dengan fallback teks.
- **Keandalan pengiriman**: antrean outbound per sesi (BullMQ/Redis), concurrency 1, rate limit per sesi, retry.
- **Penerimaan & riwayat**: pesan masuk, balasan interaktif, dan status pesan disimpan di PostgreSQL.
- **Webhook**: event per sesi, tanda tangan HMAC-SHA256 + timestamp, retry, secret dapat dirotasi.
- **Media**: penyimpanan disk, metadata DB, streaming unduh terautentikasi, retensi otomatis.
- **Keamanan**: hash API key/password/token sesi, proteksi CSRF untuk mutasi via cookie, validasi SSRF URL media/webhook, pembatasan rate.

### Arsitektur

```text
Browser (Dashboard)                     Klien (JS/PHP)
        |                                       |
        | Cookie dashboard +                    | Authorization: Bearer wag_...
        | x-dashboard-request: 1                |
        +------------------+--------------------+
                           v
                    Fastify HTTP API
                    (auth, routes, static)
                           |
          +----------------+----------------+
          |                                 |
          v                                 v
   PostgreSQL (data)                 Redis + BullMQ
 tenants/users/sessions             queue wa-outbound-<sessionId>
 api_keys/dashboard_sessions                  |
 messages/media                              v (concurrency 1, rate limit)
          ^                         Session Runtime (Baileys)
          |                                 |
          +---------- Inbound/Status -------+
                                            |
                                            v
                                       WhatsApp Web

Webhook (opsional): Fastify -> HMAC-SHA256 signed POST -> Endpoint tenant
Media: URL/upload -> validasi/SSRF -> disk (DATA_DIR/media/<tenantId>/) + metadata DB
```

Prinsip desain: satu sesi WhatsApp = satu socket + satu antrean outbound; data terisolasi per tenant; kredensial/API key tidak disimpan dalam bentuk plaintext yang dapat dipulihkan.

### Komponen utama

| Lapisan | Implementasi | Peran |
|---|---|---|
| HTTP & app | Fastify 5 (`src/app.ts`, `src/http/*`) | Routing `/v1/*`, auth, validasi, multipart, rate limit, CORS, static dashboard, health, error handling |
| Dashboard | `public/dashboard/*` (HTML/CSS/JS statis) | UI login/register/aktivasi, ringkasan, sesi & QR, kirim pesan, riwayat, analisa & statistik, webhook, API key, akun |
| Auth dashboard | `src/http/routes/auth.ts`, `src/security/dashboardAuth.ts`, `src/repos/users.ts`, `src/repos/dashboardSessions.ts` | Register/login/logout/setup/password, `scrypt` password, token sesi hash di DB, cookie `HttpOnly` |
| Auth API | `src/http/auth.ts`, `src/security/apiKey.ts`, `src/repos/apiKeys.ts` | Bearer API key (SHA-256 hash), resolusi tenant, sentuhan last-used |
| WhatsApp runtime | `src/wa/sessionManager.ts`, `src/wa/sessionRuntime.ts`, `src/wa/sender.ts`, `src/wa/inbound.ts`, `src/wa/interactive.ts` | Lifecycle sesi Baileys, QR/pairing, kirim, parsing inbound/status, interaktif + fallback |
| Antrean | `src/queue/sessionQueue.ts` (BullMQ) | Outbound per sesi, concurrency 1, jeda `WA_SEND_INTERVAL_MS`, retry/backoff |
| Persistensi | PostgreSQL + `pg` (`src/db/*`, `migrations/*`, `src/repos/*`) | Tenant, user, dashboard session, API key, WA session, message, media |
| Media | `src/media/storage.ts`, `src/media/retention.ts` | Simpan file (URL/upload), deteksi/validasi, path per tenant, hapus & retensi |
| Analisa | `src/analysis/*`, `src/analytics/*`, `src/repos/analysis.ts`, `src/repos/analytics.ts` | Analyzer heuristik + eksternal (opt-in), antrean `wa-analysis`, metrik API, retensi 30 hari |
| Webhook | `src/webhooks/dispatcher.ts`, `src/security/webhook.ts` | Dispatch event (termasuk `analysis.*`), HMAC signature, timestamp, retry bertahap, pencatatan pengiriman |
| Keamanan URL | `src/security/url.ts` | Validasi outbound URL & blokir alamat privat/reserved (SSRF) |
| Operasional | `src/index.ts`, `src/config.ts`, `Dockerfile`, `docker-compose.yml` | Bootstrap, migrasi, restore sesi, retensi, graceful shutdown, health |

### Alur end-to-end

#### 1) Onboarding tenant & login dashboard
- **Tenant baru (dashboard/API):** `POST /v1/auth/register` atau `POST /v1/tenants` → buat tenant + API key pertama (nilai asli hanya sekali) + (register) user dashboard.
- **Tenant lama aktivasi dashboard:** `POST /v1/auth/setup` dengan Bearer API key (atau tab **Aktivasi** di UI) → buat user dashboard tanpa kehilangan data/sesi.
- **Login:** `POST /v1/auth/login` (email case-insensitive, password diverifikasi `scrypt`) → cookie `wa_dashboard` (`HttpOnly`, `SameSite=Strict`, `Secure` sesuai `COOKIE_SECURE`, TTL `DASHBOARD_SESSION_TTL_DAYS`).
- **Proteksi:** mutasi via cookie wajib header `x-dashboard-request: 1`; endpoint login/register/setup dibatasi rate (10/menit/IP).

#### 2) Pembuatan & koneksi sesi WhatsApp
- Tenant membuat sesi (`POST /v1/sessions` / UI) → runtime Baileys diinisialisasi, status `pending`/`qr`.
- **QR:** `GET /v1/sessions/:id/qr` menghasilkan data URL; UI melakukan polling sampai `connected`/`logged_out`.
- **Pairing code:** `POST /v1/sessions/:id/pairing-code` dengan nomor (7–15 digit).
- Status: `pending`, `qr`, `connected`, `disconnected`, `logged_out`, `error`. Auth state disimpan di `data/auth/<sessionId>/` dan dipulihkan saat startup (kecuali `logged_out`).

#### 3) Pengiriman pesan (outbound)
- Klien memanggil endpoint kirim (teks/gambar/video/interaktif).
- Pesan dicatat (status `queued`), idempotency key per sesi didukung, lalu dienqueue ke `wa-outbound-<sessionId>`.
- Worker per sesi (concurrency 1, jeda antar kirim) memproses via Baileys; status diperbarui (`sending/sent/failed/delivered/read` sesuai event).
- **Media:** dari URL publik (divalidasi + anti-SSRF, batas ukuran) atau multipart upload; disimpan dan direferensikan ke pesan.
- **Interaktif:** tombol native flow dibungkus `viewOnceMessage` + `messageContextInfo` agar sampai ke penerima; daftar memakai `ListMessage` klasik agar tampil di iOS/Web; dapat fallback ke teks terformat bila gagal.

#### 4) Penerimaan pesan & riwayat (inbound)
- Event Baileys diparse (`inbound`) → disimpan sebagai pesan masuk (termasuk balasan interaktif), media masuk yang didukung (gambar/video) disimpan.
- Riwayat dapat diambil via `GET /v1/sessions/:id/messages` (filter arah/jenis/jid/before/limit) dan detail pesan/media.

#### 5) Webhook
- Per sesi: set `url`, `events`, `interactiveFallback`, dan `rotateSecret` (`PUT /v1/sessions/:id/webhook`).
- Event: `session.qr`, `session.connected`, `session.disconnected`, `session.logged_out`, `message.received`, `message.status`, `analysis.completed`, `analysis.failed`.
- Payload JSON berisi metadata + data; header `x-wa-event`, `x-wa-delivery`, `x-wa-timestamp`, `x-wa-signature` (`sha256=<hex>` HMAC dari `${timestamp}.${rawBody}` bila secret ada). Pengiriman dengan timeout & retry bertahap (best-effort).

#### 6) Analisa pesan dan statistik
- Pesan masuk otomatis dienqueue ke `wa-analysis` (tidak memblokir `message.received`); pesan tersimpan maupun teks bebas dapat dianalisa lewat API.
- Analyzer bawaan `heuristic-v1` menghasilkan `label`, `intent`, `score`, `keywords`, dan `summary` secara deterministik.
- Analyzer eksternal opsional: mode `external`/`both`, auth `signature` (HMAC), `bearer`, atau `none`, retry 3 kali, validasi skema respons. Nomor/JID **tidak dikirim** kecuali `redact=false`.
- Hasil analisa memicu `analysis.completed`/`analysis.failed` via webhook bila event tersebut aktif pada sesi.
- Statistik pesan, webhook, API, dan analisa tersedia di `/v1/analytics/*` dan dashboard; data analisa/metrik dihapus otomatis setelah `ANALYSIS_RETENTION_DAYS` (default 30 hari).

### Model data dan penyimpanan

- **PostgreSQL (migrasi `001_init.sql`, `002_dashboard_auth.sql`, `003_analysis.sql`)**: `tenants`, `api_keys`, `users`, `dashboard_sessions`, `sessions`, `messages`, `media`, `analysis_configs`, `message_analysis`, `webhook_deliveries`, `api_metrics_minute` (+ indeks/constraint relevan).
- **Disk (`DATA_DIR`)**: `auth/<sessionId>/` (kredensial WA), `media/<tenantId>/` (file), `tmp/` (upload sementara).
- **Redis**: backend BullMQ untuk antrean dan koordinasi job.
- **Retensi**: media dibersihkan sesuai `MEDIA_RETENTION_DAYS` (startup + periodik); hapus sesi membersihkan auth, media, dan data terkait.

### Keamanan (end-to-end)

- **Kredensial**: API key = hash SHA-256 (plaintext sekali tampil); password dashboard = `scrypt` + salt acak; token sesi dashboard = random opaque, disimpan sebagai hash.
- **Sesi dashboard**: cookie `HttpOnly`, `SameSite=Strict`, `Secure` di produksi (`COOKIE_SECURE` default mengikuti `NODE_ENV`), TTL terkonfigurasi.
- **CSRF**: mutasi berbasis cookie memerlukan header `x-dashboard-request: 1`.
- **Isolasi & otorisasi**: seluruh akses resource di-scope ke tenant terautentikasi.
- **SSRF**: URL media/webhook divalidasi; alamat privat/loopback/link-local/reserved diblokir (override eksplisit via env).
- **Hardening**: rate limit, validasi input (Zod), redaksi secret di log, CORS default tertutup, imbauan HTTPS/reverse proxy (`TRUST_PROXY`).

### Pengujian dan status

- **Pengujian otomatis**: `npm run typecheck`, `npm run build`, `npm test` — **72 tes lulus** (normalisasi JID, interaktif+fallback, signature webhook, hashing API key, hashing password/token dashboard & config cookie, deteksi IP privat/SSRF & validasi URL, analyzer internal, request/signature analyzer eksternal, rentang waktu analitik, agregasi metrik API).
- **Smoke test yang telah dilakukan**: endpoint dashboard/aset/redirect/health, auth (register/login/setup/logout/me/password, case-insensitive, wrong password, duplikat, invalidasi sesi lain), akses data via cookie, penolakan mutasi tanpa CSRF, CRUD sesi via cookie, webhook/API key via cookie.
- **Status operasional saat pelaporan**: server dev dapat dijalankan (`PORT=3100 npm run dev`), dashboard tersedia di `/dashboard/`.
- **Belum diverifikasi manual penuh**: klik-through UI di browser nyata, scan QR ke WhatsApp nyata, pengiriman/penerimaan pesan nyata, dan rendering interaktif di perangkat (desktop tidak dijamin) — memerlukan perangkat/akun WhatsApp dan akses browser.

### Batasan

- Protokol tidak resmi; risiko pemblokiran, tanpa SLA.
- Riwayat hanya pesan yang lewat gateway saat berjalan (sync riwayat penuh nonaktif).
- Media masuk yang disimpan: gambar/video; tipe lain dicatat sebagai `other` tanpa file.
- Pesan interaktif bergantung format native flow/`ListMessage` yang dapat berubah; fallback teks disediakan.
- Rate limit per proses/sesi, bukan jaminan kebijakan WhatsApp.
- Analisa memakai heuristik sederhana, bukan model NLP; hasilnya bersifat indikatif. Retensi analisa/metrik 30 hari dan metrik API disimpan per menit (agregat).
- Retry webhook in-process (best-effort); butuh penerima idempoten/rekonsiliasi untuk kebutuhan kritis.
- Satu instance menangani banyak sesi (kapasitas tergantung VPS); belum ada scaling horizontal per sesi, billing, campaign massal, atau manajemen anggota grup.
- Dashboard berfokus pada operasional satu tenant.

---

## Snapshot Dashboard

Tampilan UI dashboard yang diimplementasikan (`public/dashboard`):

### Login & aktivasi
![Login Dashboard](docs/screenshots/01-login.svg)

### Ringkasan (overview)
![Ringkasan Dashboard](docs/screenshots/02-overview.svg)

### Manajemen sesi & scan QR
![Sesi dan QR](docs/screenshots/03-sessions-qr.svg)

### Kirim pesan (teks/media/interaktif)
![Kirim Pesan](docs/screenshots/04-send.svg)

### Riwayat pesan & webhook
![Riwayat dan Webhook](docs/screenshots/05-history-webhook.svg)

---

## Cara Instalasi

### Prasyarat

- **Node.js** 20+ (disarankan LTS, diuji dengan Node 24) dan npm
- **PostgreSQL** 14+
- **Redis** 7+
- (Opsional) **Docker** + **Docker Compose** untuk deployment terkemas
- Akses jaringan ke WhatsApp Web dari server (untuk koneksi Baileys)

### Instalasi lokal (development/production)

#### 1. Clone repository

```bash
git clone git@github.com:theWorldOfFools/wa-gateway-tsany.git
cd wa-gateway-tsany
```

> Jika menggunakan HTTPS: `git clone https://github.com/theWorldOfFools/wa-gateway-tsany.git`

#### 2. Siapkan PostgreSQL dan Redis

Contoh (Ubuntu/Debian):

```bash
# PostgreSQL
sudo -u postgres psql -c "CREATE ROLE wa_gateway LOGIN PASSWORD 'ganti-password';"
sudo -u postgres psql -c "CREATE DATABASE wa_gateway OWNER wa_gateway;"

# Redis
redis-cli ping   # harus: PONG
```

Pastikan `DATABASE_URL` dan `REDIS_URL` dapat diakses dari host yang menjalankan gateway.

#### 3. Konfigurasi environment

```bash
cp .env.example .env
```

Ubah minimal nilai berikut di `.env`:

```dotenv
NODE_ENV=development          # production untuk deploy
HOST=0.0.0.0
PORT=3000

DATABASE_URL=postgres://wa_gateway:ganti-password@127.0.0.1:5432/wa_gateway
REDIS_URL=redis://127.0.0.1:6379

DATA_DIR=./data
PUBLIC_URL=http://localhost:3000   # set ke URL publik (https://domain) di produksi

# Keamanan & signup
PUBLIC_SIGNUP=true            # set false + ADMIN_SECRET untuk membatasi pendaftaran
ADMIN_SECRET=                 # isi string acak panjang bila PUBLIC_SIGNUP=false
CORS_ORIGINS=                 # kosong = nonaktif; isi origin tepercaya jika perlu
TRUST_PROXY=false             # true jika di belakang reverse proxy tepercaya

# Dashboard
DASHBOARD_SESSION_TTL_DAYS=7
COOKIE_SECURE=                # kosong = otomatis (true di production, false selain itu)

# Batas & perilaku
WA_SEND_INTERVAL_MS=1500
MAX_SESSIONS_PER_TENANT=5
MAX_SESSIONS_TOTAL=20
MEDIA_MAX_BYTES=67108864
MEDIA_RETENTION_DAYS=30
INTERACTIVE_MESSAGES_ENABLED=false  # sementara nonaktif; set true + restart untuk mengaktifkan lagi

# Analisa & statistik
ANALYSIS_ENABLED=true
ANALYSIS_RETENTION_DAYS=30
ANALYSIS_QUEUE_CONCURRENCY=2
ANALYSIS_MAX_TEXT_CHARS=4096
ANALYSIS_EXTERNAL_TIMEOUT_MS=10000
ALLOW_PRIVATE_ANALYSIS_ENDPOINTS=false
API_METRICS_FLUSH_MS=60000
```

Catatan: `dotenv` tidak menimpa environment variable yang sudah diekspor shell.

#### 4. Install dependensi

```bash
npm install
```

#### 5. Migrasi database

```bash
npm run migrate
```

Migrasi juga dapat berjalan otomatis saat startup jika `AUTO_MIGRATE=true`.

#### 6. Jalankan aplikasi

Development (watch):

```bash
npm run dev
```

Production:

```bash
npm run build
npm start
```

Secara default server mendengar di `HOST:PORT` (contoh `http://0.0.0.0:3000`). Dashboard: `http://<host>:<port>/dashboard/`.

### Menjalankan dengan Docker

```bash
cp .env.example .env
# isi setidaknya: POSTGRES_PASSWORD, PUBLIC_URL, (opsional) ADMIN_SECRET, GATEWAY_PORT
# sesuaikan nilai lain sesuai kebutuhan; DATABASE_URL/REDIS_URL untuk container di-override compose

docker compose up -d --build
docker compose logs -f gateway
```

`docker-compose.yml` menjalankan PostgreSQL, Redis, dan gateway. Data persisten di volume `postgres-data`, `redis-data`, dan `gateway-data` (auth WhatsApp + media). `POSTGRES_PASSWORD` wajib diisi; `GATEWAY_PORT` menentukan port host.

### Verifikasi instalasi

```bash
curl http://127.0.0.1:3000/health
# contoh respons: {"status":"ok","version":"0.1.0","checks":{"database":"ok","redis":"ok"}, ...}

# dashboard (HTTP 200)
curl -I http://127.0.0.1:3000/dashboard/
```

Lalu buka `/dashboard/` di browser, daftar/aktivasi/login, buat sesi, scan QR/pairing, dan uji kirim pesan.

Uji kualitas kode:

```bash
npm run typecheck
npm test
npm run build
```

---

## Dashboard Web

Dashboard statis tersedia di `/dashboard/` dan memakai API yang sama dengan integrasi REST.

- **Login:** email/password per tenant (bukan API key). Password di-hash `scrypt`, sesi disimpan sebagai hash token (`dashboard_sessions`), cookie `wa_dashboard` `HttpOnly` + `SameSite=Strict`.
- **Keamanan cookie/CSRF:** `COOKIE_SECURE` otomatis `true` saat `NODE_ENV=production`; request mutasi via cookie wajib header `x-dashboard-request: 1`.
- **Aktivasi tenant lama:** tab **Aktivasi** atau `POST /v1/auth/setup` dengan Bearer API key.
- **Fitur:** ringkasan, CRUD sesi + QR/pairing/reconnect/logout, kirim teks/media/interaktif & pilih grup, riwayat + filter/paginasi (dengan badge analisa), **Analisa** (statistik, grafik, performa webhook/API, konfigurasi analyzer, uji teks), webhook (event + rotasi secret), manajemen API key, ubah password.
- **Rate limit login:** 10 permintaan/menit/IP.

---

## Referensi API

Base URL: `PREFIX/v1`.

Autentikasi resource tenant/sesi/pesan:
- **Integrasi (disarankan):** `Authorization: Bearer wag_...`
- **Dashboard:** cookie sesi + header `x-dashboard-request: 1` untuk `POST/PUT/DELETE`

```http
Authorization: Bearer wag_...
Content-Type: application/json   (kecuali multipart)
```

### Autentikasi dashboard

| Method | Path | Keterangan |
| --- | --- | --- |
| `POST` | `/v1/auth/register` | Daftar tenant + user + API key pertama (mengikuti `PUBLIC_SIGNUP`/admin secret) |
| `POST` | `/v1/auth/login` | Login `{ "email", "password" }`, set cookie |
| `POST` | `/v1/auth/logout` | Hapus sesi dashboard (wajib CSRF header bila ada cookie) |
| `GET` | `/v1/auth/me` | Info user/tenant/sesi dashboard |
| `POST` | `/v1/auth/setup` | Buat login dashboard untuk tenant lama (wajib Bearer API key) |
| `PUT` | `/v1/auth/password` | Ubah password `{ "currentPassword", "newPassword" }` |

### Tenant dan API key

| Method | Path | Keterangan |
| --- | --- | --- |
| `POST` | `/v1/tenants` | Daftar tenant + API key pertama (publik/`x-admin-secret`) |
| `GET` | `/v1/me` | Info tenant & kredensial aktif |
| `GET` | `/v1/api-keys` | Daftar API key (tanpa nilai rahasia) |
| `POST` | `/v1/api-keys` | Buat API key; nilai asli ditampilkan sekali |
| `DELETE` | `/v1/api-keys/:id` | Revoke API key (key aktif terakhir tidak boleh direvoke) |

### Sesi WhatsApp

| Method | Path | Keterangan |
| --- | --- | --- |
| `POST` | `/v1/sessions` | Buat sesi `{ "name": "..." }` |
| `GET` | `/v1/sessions` | Daftar sesi tenant |
| `GET` | `/v1/sessions/:id` | Detail/status sesi |
| `GET` | `/v1/sessions/:id/qr` | QR sebagai `qr` + `dataUrl` |
| `POST` | `/v1/sessions/:id/pairing-code` | Pairing code `{ "phoneNumber": "628..." }` |
| `POST` | `/v1/sessions/:id/reconnect` | Minta koneksi ulang |
| `POST` | `/v1/sessions/:id/logout` | Logout & hapus auth sesi |
| `DELETE` | `/v1/sessions/:id` | Hapus sesi, antrean, auth, media, riwayat |
| `GET` | `/v1/sessions/:id/groups` | Daftar grup (sesi harus connected) |
| `GET` | `/v1/sessions/:id/groups/:jid` | Metadata grup |

### Pesan

| Method | Path | Keterangan |
| --- | --- | --- |
| `POST` | `/v1/sessions/:id/messages/text` | Kirim teks |
| `POST` | `/v1/sessions/:id/messages/image` | Kirim gambar (JSON `mediaUrl` atau multipart `file`) |
| `POST` | `/v1/sessions/:id/messages/video` | Kirim video (JSON `mediaUrl` atau multipart `file`) |
| `POST` | `/v1/sessions/:id/messages/interactive` | Kirim tombol/daftar interaktif |
| `GET` | `/v1/sessions/:id/messages` | Riwayat pesan (filter: `direction`, `kind`, `jid`, `before`, `limit`) |
| `GET` | `/v1/messages/:id` | Detail pesan |
| `GET` | `/v1/media/:id` | Unduh/stream media |

#### Bentuk request

Teks:

```json
{
  "to": "6281234567890",
  "text": "Halo dari gateway",
  "idempotencyKey": "opsional-unik-per-sesi"
}
```

Media via URL:

```json
{
  "to": "6281234567890",
  "mediaUrl": "https://example.com/gambar.jpg",
  "caption": "Opsional",
  "idempotencyKey": "opsional"
}
```

Media multipart: field `file` (wajib), `to` (wajib), `caption` (opsional), `idempotencyKey` (opsional).

Interaktif tombol:

```json
{
  "type": "buttons",
  "to": "6281234567890",
  "text": "Pilih opsi",
  "header": "Opsional",
  "footer": "Opsional",
  "fallbackText": "Opsional",
  "buttons": [
    { "id": "yes", "text": "Ya" },
    { "id": "no", "text": "Tidak" }
  ],
  "idempotencyKey": "opsional"
}
```

Interaktif daftar:

```json
{
  "type": "list",
  "to": "6281234567890",
  "text": "Pilih layanan",
  "buttonText": "Lihat layanan",
  "sections": [
    {
      "title": "Layanan",
      "rows": [
        { "id": "basic", "title": "Paket Basic", "description": "1 nomor" }
      ]
    }
  ]
}
```

`to` menerima nomor (`62...`), JID user (`...@s.whatsapp.net`), atau grup (`...@g.us`).

Respons kirim: `202` `{ "message": { ...status queued... } }`. Idempotency key sama pada pesan yang sudah selesai mengembalikan `200` dengan pesan yang sudah ada.

### Endpoint analisa dan statistik

| Method | Path | Keterangan |
| --- | --- | --- |
| `GET` | `/v1/config` | Flag publik: `interactiveMessagesEnabled`, `analysisEnabled` |
| `GET` | `/v1/analysis/config` | Konfigurasi analyzer tenant (secret tidak ditampilkan) |
| `PUT` | `/v1/analysis/config` | Atur `enabled`, `mode`, `endpoint`, `authMode`, `secret`, `redact`, `maxChars`, `timeoutMs` |
| `POST` | `/v1/analysis/text` | Analisa teks bebas (tanpa menyimpan pesan) |
| `POST` | `/v1/analysis/messages/:id` | Queue analisa ulang pesan (`202`, `status: queued`) |
| `GET` | `/v1/analysis/messages/:id` | Daftar hasil analisa suatu pesan |
| `GET` | `/v1/analysis` | Daftar hasil (filter `from`, `to`, `sessionId`, `source`, `label`, `limit`) |
| `GET` | `/v1/analytics/summary` | Ringkasan pesan + analisa |
| `GET` | `/v1/analytics/timeseries` | Deret waktu pesan (`bucket=hour\|day`) |
| `GET` | `/v1/analytics/top-chats` | Chat teratas (JID disaring per tenant) |
| `GET` | `/v1/analytics/webhook` | Statistik pengiriman webhook |
| `GET` | `/v1/analytics/api` | Statistik permintaan API per endpoint |

Semua endpoint analitik menerima `from`/`to` (ISO 8601, maksimal 90 hari; default 7 hari) dan opsional `sessionId`. Contoh:

```bash
curl -X POST http://localhost:3000/v1/analysis/text \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"text":"Terima kasih, layanannya cepat","source":"internal"}'
```

```json
{
  "source": "internal",
  "result": {
    "label": "positive",
    "intent": "thanks",
    "score": 0.5,
    "keywords": ["layanannya"],
    "summary": "Terima kasih, layanannya cepat"
  },
  "version": "heuristic-v1"
}
```

Konfigurasi analyzer eksternal:

```json
{
  "enabled": true,
  "mode": "both",
  "endpoint": "https://analyzer.example.com/v1/analyze",
  "authMode": "signature",
  "secret": "ansec_...",
  "redact": true,
  "maxChars": 4096,
  "timeoutMs": 10000
}
```

Secret hanya dikembalikan sekali saat dibuat/dirotasi. Payload analyzer eksternal mengikuti bentuk event webhook (`analysis.request`) dengan header `x-wa-signature` bila memakai `signature`, dan respons wajib berisi `label` (`positive`/`negative`/`neutral`) serta opsional `intent`, `score`, `keywords`, `summary`, `analyzerVersion`.

### Webhook sesi

| Method | Path | Keterangan |
| --- | --- | --- |
| `GET` | `/v1/sessions/:id/webhook` | Konfigurasi webhook (secret tidak pernah ditampilkan) |
| `PUT` | `/v1/sessions/:id/webhook` | Atur webhook; `secret` hanya saat dibuat/dirotasi |

```json
{
  "url": "https://example.com/webhook",
  "events": ["message.received", "message.status"],
  "interactiveFallback": true,
  "rotateSecret": false
}
```

Set `url: null` untuk menonaktifkan.

### Format error

```json
{
  "error": {
    "code": "kode_error",
    "message": "Penjelasan",
    "details": {}
  }
}
```

Kode umum: `bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `rate_limited`, `payload_too_large`, `session_not_connected`, `qr_unavailable`, `csrf_check_failed`, `invalid_credentials`, dll.

---

## Contoh JavaScript

### Buat tenant, sesi, dan kirim teks

```js
const base = 'http://localhost:3000';

const tenantRes = await fetch(`${base}/v1/tenants`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Toko Saya' })
});
const { apiKey } = await tenantRes.json();
const key = apiKey.key; // simpan aman, hanya sekali tampil

const sessionRes = await fetch(`${base}/v1/sessions`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json'
  },
  body: JSON.stringify({ name: 'Nomor CS' })
});
const { session } = await sessionRes.json();

// Setelah sesi connected:
const send = await fetch(`${base}/v1/sessions/${session.id}/messages/text`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json'
  },
  body: JSON.stringify({
    to: '6281234567890',
    text: 'Halo dari gateway',
    idempotencyKey: `notify-${Date.now()}`
  })
});
console.log(send.status, await send.json());
```

### Upload gambar (Node.js)

```js
import { readFile } from 'node:fs/promises';

const form = new FormData();
form.append('file', new Blob([await readFile('./produk.jpg')], { type: 'image/jpeg' }), 'produk.jpg');
form.append('to', '6281234567890');
form.append('caption', 'Foto produk');

await fetch(`${base}/v1/sessions/${sessionId}/messages/image`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}` },
  body: form
});
```

### Poll status sesi

```js
async function waitUntilConnected(sessionId, apiKey, timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${base}/v1/sessions/${sessionId}`, {
      headers: { authorization: `Bearer ${apiKey}` }
    });
    const { session } = await res.json();
    if (session.status === 'connected') return session;
    if (session.status === 'logged_out') throw new Error('Session logged out');
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('Timed out waiting for WhatsApp connection');
}
```

---

## Contoh PHP

### Kirim teks

```php
<?php
$base = 'http://localhost:3000';
$apiKey = getenv('WA_GATEWAY_KEY');
$sessionId = 'SESSION_ID';

$payload = [
  'to' => '6281234567890',
  'text' => 'Halo dari PHP',
  'idempotencyKey' => 'php-' . time(),
];

$ch = curl_init("$base/v1/sessions/$sessionId/messages/text");
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => [
    "Authorization: Bearer $apiKey",
    'Content-Type: application/json',
  ],
  CURLOPT_POSTFIELDS => json_encode($payload),
]);

$body = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
curl_close($ch);
if ($status >= 400) throw new RuntimeException("Gateway error ($status): $body");
echo $body;
```

### Upload gambar

```php
<?php
$path = __DIR__ . '/produk.jpg';
$ch = curl_init("$base/v1/sessions/$sessionId/messages/image");
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ["Authorization: Bearer $apiKey"],
  CURLOPT_POSTFIELDS => [
    'file' => new CURLFile($path, mime_content_type($path), basename($path)),
    'to' => '6281234567890',
    'caption' => 'Foto produk',
  ],
]);
$body = curl_exec($ch);
curl_close($ch);
```

### Pesan interaktif

```php
<?php
$payload = [
  'type' => 'buttons',
  'to' => '6281234567890',
  'text' => 'Apakah pesanan sudah diterima?',
  'buttons' => [
    ['id' => 'received', 'text' => 'Sudah'],
    ['id' => 'not_yet', 'text' => 'Belum'],
  ],
];
$ch = curl_init("$base/v1/sessions/$sessionId/messages/interactive");
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => ["Authorization: Bearer $apiKey", 'Content-Type: application/json'],
  CURLOPT_POSTFIELDS => json_encode($payload),
]);
$body = curl_exec($ch);
curl_close($ch);
```

---

## Webhook

Aktifkan per sesi:

```bash
curl -X PUT http://localhost:3000/v1/sessions/$SESSION_ID/webhook \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://aplikasi.example.com/webhook/wa",
    "events": ["message.received", "message.status", "session.connected"],
    "interactiveFallback": true
  }'
```

Event: `session.qr`, `session.connected`, `session.disconnected`, `session.logged_out`, `message.received`, `message.status`, `analysis.completed`, `analysis.failed`.

Header penting: `x-wa-event`, `x-wa-delivery`, `x-wa-timestamp`, `x-wa-signature` (`sha256=<hex>` jika secret ada). Signature = HMAC-SHA256 atas `${timestamp}.${rawBody}`.

Verifikasi (Node.js):

```js
import crypto from 'node:crypto';

function verifyWebhook(rawBody, headers, secret) {
  const timestamp = headers['x-wa-timestamp'];
  const signature = headers['x-wa-signature'];
  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex')}`;
  return signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

Verifikasi (PHP):

```php
<?php
$rawBody = file_get_contents('php://input');
$timestamp = $_SERVER['HTTP_X_WA_TIMESTAMP'] ?? '';
$signature = $_SERVER['HTTP_X_WA_SIGNATURE'] ?? '';
$expected = 'sha256=' . hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);
if (!hash_equals($expected, $signature)) { http_response_code(401); exit('invalid signature'); }
```

Balas `2xx` dengan cepat; proses berat sebaiknya asynchronous.

---

## Analisa dan statistik

- **Analisa isi:** bawaan `heuristic-v1` (deterministik) dan/atau analyzer eksternal yang dikonfigurasi per tenant. Mode: `internal` (default), `external`, `both`.
- **Trigger:** pesan masuk dianalisa otomatis via antrean BullMQ `wa-analysis`; pesan tersimpan dan teks bebas dapat diminta lewat REST API.
- **Konsumsi hasil:** `GET`/`POST /v1/analysis/*`, event webhook `analysis.completed`/`analysis.failed`, dan menu **Analisa** di dashboard (kartu statistik, grafik aktivitas, distribusi label, performa webhook/API, konfigurasi analyzer, uji teks). Badge hasil analisa juga tampil di Riwayat pesan.
- **Statistik:** `/v1/analytics/summary|timeseries|top-chats|webhook|api`, dengan filter tenant/sesi dan rentang waktu (default 7 hari, maksimal 90 hari). Metrik API dikumpulkan per menit lalu di-flush ke PostgreSQL.
- **Privasi:** default `redact=true`, sehingga JID/nomor tidak dikirim ke analyzer eksternal. Endpoint eksternal divalidasi terhadap SSRF; alamat privat hanya diizinkan dengan `ALLOW_PRIVATE_ANALYSIS_ENDPOINTS=true`.
- **Retensi:** hasil analisa, catatan pengiriman webhook, dan metrik API dihapus setelah `ANALYSIS_RETENTION_DAYS` (default 30 hari). Set `0` untuk menonaktifkan penghapusan otomatis.
- **Penonaktifan:** `ANALYSIS_ENABLED=false` membuat endpoint analisa mengembalikan `410 analysis_disabled` dan menu Analisa dinonaktifkan di dashboard.

## Media dan Retensi

- Media: `DATA_DIR/media/<tenantId>/`, metadata di PostgreSQL.
- Auth WhatsApp: `DATA_DIR/auth/<sessionId>/`, upload sementara: `DATA_DIR/tmp/`.
- Batas ukuran: `MEDIA_MAX_BYTES` (default 64 MB).
- Retensi: `MEDIA_RETENTION_DAYS` (default 30, `0` = nonaktif), berjalan saat startup & periodik.
- Unduh media: `GET /v1/media/:id` (terautentikasi, milik tenant).
- Hapus sesi menghapus auth, file media, metadata, dan riwayat terkait.
- Backup minimal: database PostgreSQL + direktori `data/auth` dan `data/media`.

---

## Konfigurasi

| Variable | Default | Keterangan |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, `production` |
| `HOST` | `0.0.0.0` | Alamat bind HTTP |
| `PORT` | `3000` | Port HTTP |
| `DATABASE_URL` | wajib | Koneksi PostgreSQL |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Koneksi Redis/BullMQ |
| `DATA_DIR` | `./data` | Direktori auth, media, tmp |
| `PUBLIC_URL` | kosong | Base URL untuk tautan media di respons |
| `PUBLIC_SIGNUP` | `true` | Izinkan signup tenant/dashboard tanpa admin secret |
| `ADMIN_SECRET` | kosong | Header `x-admin-secret` saat signup dibatasi |
| `TRUST_PROXY` | `false` | Aktifkan di belakang reverse proxy tepercaya |
| `CORS_ORIGINS` | kosong | Daftar origin dipisah koma (kosong = nonaktif) |
| `RATE_LIMIT_MAX` | `300` | Maks request/menit/IP |
| `DASHBOARD_SESSION_TTL_DAYS` | `7` | Masa berlaku login dashboard (hari) |
| `COOKIE_SECURE` | otomatis | `true` jika `NODE_ENV=production` saat kosong |
| `LOG_LEVEL` | `info` | Level log Pino |
| `AUTO_MIGRATE` | `true` | Jalankan migrasi saat startup |
| `INTERACTIVE_MESSAGES_ENABLED` | `true` | Aktifkan pesan interaktif; endpoint mengembalikan `410` saat `false` |
| `ANALYSIS_ENABLED` | `true` | Aktifkan analisa isi pesan & metrik |
| `ANALYSIS_RETENTION_DAYS` | `30` | Retensi hasil analisa/webhook/API (`0` = nonaktif) |
| `ANALYSIS_QUEUE_CONCURRENCY` | `2` | Parallelisme worker antrean `wa-analysis` |
| `ANALYSIS_MAX_TEXT_CHARS` | `4096` | Batas teks yang dianalisa |
| `ANALYSIS_EXTERNAL_TIMEOUT_MS` | `10000` | Timeout analyzer eksternal (ms) |
| `ALLOW_PRIVATE_ANALYSIS_ENDPOINTS` | `false` | Izinkan endpoint analyzer ke IP privat |
| `API_METRICS_FLUSH_MS` | `60000` | Interval flush metrik API ke PostgreSQL |
| `MEDIA_MAX_BYTES` | `67108864` | Batas ukuran media (byte) |
| `MEDIA_RETENTION_DAYS` | `30` | Retensi media (`0` = nonaktif) |
| `ALLOW_PRIVATE_MEDIA_URLS` | `false` | Izinkan URL media ke IP privat |
| `ALLOW_PRIVATE_WEBHOOKS` | `false` | Izinkan webhook ke IP privat |
| `WEBHOOK_TIMEOUT_MS` | `10000` | Timeout webhook/download media |
| `WA_SEND_INTERVAL_MS` | `1500` | Jeda minimum antar pesan per sesi |
| `MAX_SESSIONS_PER_TENANT` | `5` | Batas sesi per tenant |
| `MAX_SESSIONS_TOTAL` | `20` | Batas sesi total |
| `SESSION_MAX_RECONNECT_DELAY_MS` | `30000` | Batas backoff reconnect |

---

## Operasional

### Keamanan deployment
- Gunakan **HTTPS** (Nginx/Caddy/Cloudflare Tunnel); jangan ekspos gateway langsung tanpa TLS.
- Produksi: `COOKIE_SECURE=true` (otomatis), `PUBLIC_SIGNUP=false` + `ADMIN_SECRET` kuat bila perlu membatasi pendaftaran.
- Lindungi `DATA_DIR` (berisi auth WhatsApp) dan jangan ekspos PostgreSQL/Redis ke internet.
- Revoke API key yang bocor; rotasi secret webhook bila perlu.

Contoh Nginx (reverse proxy):

```nginx
server {
    listen 443 ssl http2;
    server_name gateway.example.com;
    client_max_body_size 70m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

Jika memakai reverse proxy tepercaya, set `TRUST_PROXY=true`.

### Kesehatan, log, lifecycle
- Health: `GET /health` (tanpa auth) → `200` jika DB & Redis sehat, `503` jika tidak.
- Log: JSON (Pino), secret/authorization di-redact.
- Startup: migrasi (opsional) → pulihkan sesi tersimpan (kecuali `logged_out`) → scheduler retensi.
- Graceful shutdown: tutup HTTP, socket WhatsApp, antrean, Redis, PostgreSQL.
- Satu sesi harus dilayani satu instance; hindari menjalankan dua worker untuk sesi yang sama.

Systemd contoh:

```ini
[Unit]
Description=WhatsApp Gateway
After=network.target postgresql.service redis-server.service

[Service]
Type=simple
WorkingDirectory=/opt/wa-gateway-tsany
EnvironmentFile=/opt/wa-gateway-tsany/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
User=www-data

[Install]
WantedBy=multi-user.target
```

---

Lisensi: ISC (lihat `package.json`). Kontribusi/penggunaan mengikuti risiko protokol tidak resmi yang disebutkan di atas.
