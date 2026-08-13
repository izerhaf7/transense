## Why

Antar Aku saat ini hanya melacak satu armada ke satu halte tujuan — tidak mencari rute tercepat dari titik A ke titik B. Pengguna Tuli butuh rencana perjalanan yang jelas (naik koridor apa, jalan ke halte mana, pindah di mana) dari lokasi sekarang ke tujuan, bukan sekadar melihat satu bus.

## What Changes

- Menambahkan mesin pencari rute (trip planner) di backend: dari asal ke tujuan, cari rute transit tercepat lewat jaringan TransJakarta (GTFS), dengan leg jalan kaki (walk graph OSM precompute) ke/dari halte dan antar-transfer.
- Menambahkan endpoint `/api/journey/plan` yang menerima asal & tujuan (koordinat atau stop id) dan mengembalikan itinerary (daftar leg walk/transit: waktu, jarak, rute, headsign) plus alternatif rute.
- Menambahkan parsing `transfers.txt` dan `calendar.txt`/`calendar_dates.txt` ke `gtfs_loader.py` (backward-compatible).
- Menambahkan walk graph dari OSM (precompute, offline) untuk jarak jalan nyata access/egress dan transfer antar halte.
- Mengubah layar Antar Aku dari tracker menjadi planner-first: input asal & tujuan, tampil daftar leg + alternatif, gambar polyline per leg di Mapbox, lalu lanjut ke mode tracking setelah rute dipilih.

### Non-goals

- Tidak mencari rute lintas operator (KCI/MRT/LRT); scope hanya TransJakarta.
- Tidak overlay delay realtime ke hasil rute pada iterasi ini; rute berbasis jadwal statis.
- Tidak menyediakan turn-by-turn navigasi jalan kaki; jarak/waktu jalan memakai walk graph OSM precompute (bukan routing jalan on-demand).
- Tidak routing wheelchair/mobilitas khusus atau profil disabilitas lain.
- Tidak menyimpan riwayat pencarian rute ke persistence pada iterasi ini.

## Capabilities

### New Capabilities

- `trip-planner`: Pencarian rute transit A→B (RAPTOR) dengan leg walk + transit, alternatif rute, dan integrasi peta.

### Modified Capabilities

Tidak ada; belum ada capability routing di repository.
