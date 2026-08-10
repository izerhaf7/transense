## Why

Keluhan utama wawancara adalah jadwal TransJakarta yang tidak andal serta tidak adanya informasi keterlambatan atau insiden yang mudah diakses. Change ini menggabungkan tracking, notifikasi visual+haptic, dan Antar Aku menjadi satu jalur perjalanan yang terasa nyata di demo, dengan data dummy yang dapat dikontrol.

## What Changes

- Menampilkan jadwal dan posisi armada TransJakarta dari dummy feed melalui WebSocket.
- Menambahkan notification engine untuk armada mendekat, halte tujuan mendekat, dan update resmi keterlambatan/insiden.
- Menampilkan notifikasi sebagai teks besar, kontras tinggi, kilat tepi layar, dan pola getar khas di Android.
- Menyimpan feed/history keterlambatan dan insiden selama 7 hari; struktur insiden memuat status, penyebab, tindakan, instruksi, dan timestamp update.
- Mengisi tab Keterlambatan pada wireframe dengan feed insiden yang dapat dibaca ulang.
- Menambahkan alur Antar Aku: input tujuan, pencocokan halte asal/tujuan terdekat berbasis dummy, rute sederhana, dan integrasi event perjalanan.
- Menyediakan trigger terkontrol untuk simulasi keluar-rute pada rekaman demo.

### Non-goals

- Tidak mengintegrasikan API resmi TransJakarta atau feed insiden produksi; sumber demo tetap dummy/simulasi.
- Tidak mengimplementasikan geolocation real dan perhitungan deviasi rute akurat; keluar-rute hanya mock/debug trigger untuk demo.
- Tidak menggunakan computer vision/OCR untuk mendeteksi armada atau nomor koridor; fitur profil netra sudah dihapus permanen.
- Tidak membuat crowdsourced incident reporting.
- Tidak mengimplementasikan navigasi jalan kaki di dalam halte atau pola getar salah arah.
- Tidak membangun peta interaktif penuh bila rute sederhana/statik sudah cukup untuk bukti demo.
- Tidak mengimplementasikan profil mobilitas/kursi roda, Buddy Up!, atau wearable/IoT band.

## Capabilities

### New Capabilities

- `fleet-schedule-tracking`: Jadwal, posisi armada, ETA, dan simulasi update real-time.
- `transit-notifications`: Event notification, renderer visual+haptic, pola getar, serta histori insiden 7 hari.
- `antar-aku-journey`: Pemilihan tujuan, rute halte-ke-halte, journey state, integrasi notifikasi, dan off-route mock.

### Modified Capabilities

Tidak ada; belum ada spesifikasi capability existing di repository.

## Impact

- Bergantung pada `demo-shell-and-data-foundation` untuk dummy transit contract, FastAPI/WebSocket, persistence, navigasi, dan deployment.
- Menjadi consumer utama data posisi armada, ETA, dan incident feed; kontrak tersebut harus tetap dapat diganti API TransJakarta riil pada iterasi berikutnya.
- Membutuhkan device Android nyata untuk memvalidasi `navigator.vibrate()` dan pola berbeda untuk minimal tiga jenis notifikasi.
- Sebaiknya notification engine dikerjakan sebelum routing Antar Aku agar fitur inti tetap punya jalur demo jika waktu solo terbatas.
- Semua task implementasi nantinya harus dipecah maksimal 2 jam dan nice-to-have ditunda sampai jalur demo stabil.
