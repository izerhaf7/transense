## 1. WebSocket Notification Protocol

- [x] 1.1 Perluas kontrak `transit-demo.v1` dengan pesan notifikasi aditif: `notification.vehicle_approaching`, `notification.destination_approaching`, `notification.incident`, dan `journey.off_route`, masing-masing dengan `event_id` stable dan timestamp UTC; jaga pesan foundation (`connection.ack`, `transit.update`, `transit.reset`, `error`) tetap kompatibel
- [x] 1.2 Unit test kontrak: setiap pesan notifikasi memiliki field wajib yang valid, timestamp valid, dan event id unik per tipe

## 2. Backend Notification Engine

- [x] 2.1 Implementasikan evaluasi threshold deterministik untuk approaching vehicle dan destination stop berdasarkan state armada seeded pada journey aktif
- [x] 2.2 Implementasikan feed insiden deterministik terstruktur (status, penyebab, tindakan, instruksi, timestamp update) dengan update progresif bertahap
- [x] 2.3 Publikasikan event notifikasi ke client yang subscribe melalui `/api/ws` dan verifikasi perilaku saat referensi armada/rute tidak dikenal

## 3. Incident Persistence 7 Hari

- [x] 3.1 Persist notifikasi insiden resmi ke `DemoStore` dengan `record_type: "incident"`, payload terstruktur, dan `created_at` valid
- [x] 3.2 Unit test retensi 7 hari untuk insiden, pengecualian pinned, dan validasi timestamp record insiden melalui lifecycle cleanup bersama

## 4. Jadwal & Tracking Armada (Schedule Screen)

- [x] 4.1 Implementasikan layar Jadwal TransJakarta yang menampilkan rute, armada, dan ETA dari state seeded `/api/ws`
- [x] 4.2 Tampilkan update ETA/posisi secara real-time dari event WebSocket dan kembalikan ke seed saat reset
- [x] 4.3 Beri label simulasi yang jelas pada layar jadwal; jangan menyiratkan feed TransJakarta live

## 5. Notification Renderer Audio-Blind

- [x] 5.1 Implementasikan banner notifikasi teks besar kontras tinggi dengan warna status semantik (safe untuk status perjalanan, danger untuk insiden)
- [x] 5.2 Implementasikan overlay edge flash visual murni (CSS) yang berhenti saat dismiss/expiry
- [x] 5.3 Implementasikan tiga pola getar berbeda via `navigator.vibrate()` sesuai design.md dengan fallback visual-only jika Vibration API tidak tersedia
- [x] 5.4 Unit test pola getar: tiga pola terdokumentasi berbeda satu sama lain dan mengembalikan nilai yang diharapkan
- [x] 5.5 Verifikasi ketiga pola getar pada device Android nyata sebelum rekaman demo

## 6. Feed Keterlambatan 7 Hari

- [x] 6.1 Hubungkan tab Keterlambatan ke histori insiden dari `DemoStore` yang dapat dibaca ulang
- [x] 6.2 Tambahkan aksi simpan/pin per record insiden yang mengecualikan record dari cleanup 7 hari
- [x] 6.3 Beri label simulasi eksplisit pada feed; jangan menyiratkan integrasi insiden resmi TransJakarta

## 7. Antar Aku Journey

- [x] 7.1 Implementasikan input tujuan dan pencocokan halte asal/tujuan terdekat berbasis konteks seeded (bukan geolocation)
- [x] 7.2 Tampilkan rute halte-ke-halte sederhana dari kontrak rute bersama dengan state no-match/route-unavailable yang jelas
- [x] 7.3 Implementasikan state machine journey (entry -> matching -> route -> active -> ended) yang bertahan saat berpindah layar dalam sesi
- [x] 7.4 Integrasikan notifikasi approaching vehicle, destination stop, dan insiden ke dalam konteks journey aktif
- [x] 7.5 Implementasikan trigger debug terkontrol untuk simulasi keluar-rute beserta warning yang jelas dan state resolved

## 8. Optional Commute API Source

- [x] 8.1 Implementasikan adapter opsional ke Commute Data Platform (REST/OpenAPI) untuk stasiun, lin, dan jadwal TransJakarta dengan atribusi ODbL di UI
- [x] 8.2 Implementasikan fallback ke seed saat sumber tidak dikonfigurasi, tidak dapat dijangkau, atau gagal validasi mapping; pastikan sumber tidak pernah dipakai untuk posisi live atau insiden

## 9. Validasi Demo & Verifikasi

- [x] 9.1 Smoke test di Android nyata: onboarding -> Beranda -> Jadwal -> Keterlambatan -> Antar Aku -> Profil dengan ketiga pola getar
- [x] 9.2 Verifikasi alur off-route terkontrol pada browser demo dan status resolved kembali ke route state
- [x] 9.3 Jalankan seluruh unit test backend, `npm run typecheck`, `npm run build`, dan `openspec validate --strict` untuk change ini
