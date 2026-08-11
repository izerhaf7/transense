## Why

Transense membutuhkan rumah aplikasi yang bisa dibuka dan direkam di Android sebelum fitur utama dikembangkan. Fondasi bersama ini mencegah tracking, notifikasi, dan transkripsi membuat kontrak data, navigasi, penyimpanan, atau deployment masing-masing.

## What Changes

- Membuat shell PWA React + Vite dalam monorepo dengan layout mobile portrait dan dark visual direction dari wireframe Beranda.
- Menyediakan onboarding sederhana, Beranda, Profil, dan tab Keterlambatan; Beranda memuat greeting, search halte/rute, status card keterlambatan rute terdekat, serta empat entry point sesuai wireframe.
- Menyediakan backend FastAPI + WebSocket dasar dan koneksi frontend-backend.
- Menyediakan SQLite lokal untuk data persisten dan pembersihan otomatis data yang melewati 7 hari.
- Menetapkan kontrak dummy/seed untuk halte, rute, perjalanan, posisi armada, ETA, dan feed insiden agar dapat dipakai change journey.
- Menyediakan simulasi data dan deployment demo: PWA di Vercel, backend FastAPI + WebSocket di Render free tier.

### Non-goals

- Tidak mengintegrasikan API TransJakarta riil pada iterasi ini.
- Tidak mengimplementasikan fitur transkripsi, tracking live, notifikasi fungsional, atau Antar Aku; entry point boleh mengarah ke placeholder.
- Tidak membuat peta interaktif di Beranda; wireframe menggunakan status card. Peta/rute dibahas di change journey.
- Tidak membuat autentikasi/login produksi; onboarding cukup untuk kebutuhan demo.
- Tidak mengimplementasikan profil netra, mobilitas/kursi roda, Buddy Up!, atau wearable/IoT band.

## Capabilities

### New Capabilities

- `demo-app-shell`: Shell PWA, navigasi utama, dan struktur layar demo Transense.
- `shared-transit-data`: Kontrak dummy/seed untuk halte, rute, perjalanan, posisi armada, ETA, dan insiden.
- `demo-persistence`: SQLite lokal dan lifecycle cleanup data 7 hari.
- `demo-runtime-foundation`: FastAPI, WebSocket dasar, simulasi event, dan deployment demo.

### Modified Capabilities

Tidak ada; belum ada spesifikasi capability existing di repository.

## Impact

- Menjadi dependency untuk `transcribe-with-7-day-history` dan `journey-tracking-notifications-and-antar-aku`.
- Menentukan struktur monorepo frontend/backend, kontrak data lintas fitur, endpoint WebSocket, dan persistence layer.
- Status card Beranda membutuhkan data rute terdekat dari dummy feed; apakah lokasi rute dimock atau memakai geolocation riil perlu diputuskan di design, dengan default mock untuk demo.
- Implementasi harus memprioritaskan jalur demo Android dan unit smoke foundation dalam task maksimal 2 jam.
