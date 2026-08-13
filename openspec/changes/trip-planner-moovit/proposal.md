## Why

Planner statis (trip-planner-routing) sudah bisa mencari rute A→B dari jadwal GTFS. Pengguna Tuli butuh pengalaman perencanaan ala Moovit: tahu gangguan yang memotong rute, bisa merencanakan ulang berdasarkan waktu tiba (bukan cuma waktu berangkat), melihat keterlambatan pada tiap leg perjalanan, dan menyimpan halte favorit + riwayat pencarian agar tidak mengetik ulang. Semua tetap audio-blind (teks besar, kontras tinggi) dan berjalan di seed/simulasi deterministik untuk demo.

## What Changes

- Menambahkan mode `arrive_by` ke planner dan endpoint `/api/journey/plan`: pengguna memilih "saya ingin tiba jam X", sistem menghitung jam berangkat terakhir (reverse RAPTOR), bukan hanya mode departure.
- Menambahkan estimasi keterlambatan per leg bus (deterministik, dari seed/simulasi) yang ditampilkan sebagai badge delay + label "simulasi"; memakai ETA realtime bila tersedia.
- Menampilkan gangguan aktif (status delay/diverted) yang memotong rute hasil pencarian, cocok dengan route id/short name leg, plus daftar gangguan aktif sebagai banner.
- Menyimpan halte favorit dan riwayat pencarian rute di localStorage frontend (tanpa sinkronisasi backend).

### Non-goals

- Tidak menambah pencarian rute multi-operator (MRT/KRL/LRT); scope tetap TransJakarta.
- Tidak menyediakan turn-by-turn navigasi jalan kaki; panduan jalan tetap berbasis walk graph/estimasi (fitur arah kompas ditunda ke iterasi berikutnya).
- Tidak menambahkan profil mobilitas/wheelchair, netra, atau navigasi dalam ruangan.
- Tidak menyinkronkan saved places/riwayat ke backend; murni localStorage perangkat.
- Tidak menampilkan overlay gangguan di peta (polyline diwarnai ulang); cukup banner + penanda leg.
- Tidak menambahkan notifikasi getar baru; notifikasi perjalanan tetap milik transit-notifications.

## Capabilities

### New Capabilities

- `trip-planner-moovit`: Perencanaan rute lanjutan — arrive-by, keterlambatan per leg, gangguan di rute, halte favorit, dan riwayat pencarian.

### Modified Capabilities

Tidak ada; memperluas capability `trip-planner` yang sudah ada dari change trip-planner-routing.
