## 1. Monorepo & Runtime Dasar

- [x] 1.1 Buat struktur monorepo `frontend/` (React + Vite) dan `backend/` (FastAPI) dengan konfigurasi tooling dasar
- [x] 1.2 Buat backend FastAPI dengan endpoint health (`/api/health`) yang melaporkan status runtime dan akses persistence layer
- [x] 1.3 Buat WebSocket endpoint `/api/ws` yang menerima koneksi demo client dan mengirim simulated event
- [x] 1.4 Konfigurasi CORS dan WebSocket origin handling di backend agar dapat diakses dari origin PWA yang didokumentasikan
- [x] 1.5 Verifikasi lokal: health check berstatus healthy dan WebSocket dapat dihubungkan dari frontend lokal

## 2. Design Tokens & Visual Baseline

- [x] 2.1 Implementasikan design token semantic sesuai design.md (warna, tipografi, spacing, touch target) sebagai satu sumber token
- [x] 2.2 Terapkan baseline audio-blind: teks besar, kontras tinggi, status dan aksi utama tampil secara visual pada shell

## 3. App Shell & Navigasi

- [x] 3.1 Implementasikan PWA shell React + Vite dengan manifest dan service worker dasar
- [x] 3.2 Implementasikan onboarding sederhana: input display name + validasi kosong, lalu lanjut ke Beranda
- [x] 3.3 Implementasikan bottom navigation Beranda / Keterlambatan / Profil beserta routing halaman
- [x] 3.4 Implementasikan Beranda sesuai wireframe: greeting, search halte/rute entry point, status card, empat feature tile
- [x] 3.5 Tambahkan placeholder eksplisit untuk fitur yang belum tersedia di Beranda (Transcribe, Antar Aku, dst.)

## 4. Shared Transit Data & Status Card

- [x] 4.1 Implementasikan model dummy/seed untuk halte, rute, perjalanan, posisi armada, ETA, dan incident feed dengan stable ID
- [x] 4.2 Implementasikan validasi seed: referensi unknown/incomplete ditolak dan tidak dipublikasikan
- [x] 4.3 Implementasikan event update transit deterministik (vehicle/ETA advance) via WebSocket
- [x] 4.4 Implementasikan status card Beranda menggunakan seeded nearest-route context (mock, bukan geolocation real)
- [x] 4.5 Verifikasi status card berubah saat event dummy disuntikkan dan reset seed kembali ke state awal

## 5. Persistence & Cleanup 7 Hari

- [x] 5.1 Implementasikan penyimpanan SQLite untuk record demo dengan creation timestamp dan stable ID
- [x] 5.2 Implementasikan cleanup otomatis record non-exempt >7 hari dari satu lifecycle path aplikasi
- [x] 5.3 Implementasikan flag save/pinned untuk record yang boleh dikecualikan dari cleanup
- [x] 5.4 Unit test: retensi 7 hari, pengecualian pinned, dan validasi timestamp record

## 6. Deployment Demo (Vercel + Google Cloud Run)

- [x] 6.1 Deployment spike: deploy PWA ke Vercel dan FastAPI ke Google Cloud Run; verifikasi REST + WebSocket + CORS end-to-end dari URL deployed
- [x] 6.2 Dokumentasikan URL backend dan konfigurasi environment untuk frontend dan backend
- [x] 6.3 Buka deployed PWA di Android browser dan verifikasi navigasi, status card, dan koneksi WebSocket
- [x] 6.4 Buat fallback local replay path yang dapat dipakai jika free-tier membatasi jalur demo

## 7. Validasi Demo & Smoke Test

- [x] 7.1 Smoke test alur utama di Android nyata: onboarding → Beranda → tab Keterlambatan → Profil
- [x] 7.2 Verifikasi status card dan koneksi WebSocket berjalan di device Android nyata, bukan hanya desktop
- [x] 7.3 Pastikan seluruh task di atas selesai dan validasi `openspec validate --strict` untuk change ini
