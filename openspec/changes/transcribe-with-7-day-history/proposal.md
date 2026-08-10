## Why

Pengguna Tuli membutuhkan cara memahami percakapan langsung dengan petugas atau orang lain ketika komunikasi verbal diperlukan. Fitur ini harus menjadi alur end-to-end yang bisa didemokan: audio dari mikrofon HP diproses cloud menjadi teks, lalu histori fungsional dapat dibaca ulang selama 7 hari.

## What Changes

- Menambahkan layar Transcribe yang dapat meminta akses mikrofon Android dan memulai/menghentikan sesi.
- Mengirim audio percakapan dari frontend melalui backend FastAPI ke Cloud STT API dengan cloud inference.
- Menampilkan hasil transkripsi near-real-time dengan teks besar dan layout yang mudah dibaca.
- Menyimpan transkrip fungsional ke SQLite serta menyediakan histori sampai 7 hari.
- Menambahkan flag "simpan ini" untuk mengecualikan transkrip tertentu dari cleanup otomatis.
- Menyediakan seed/mock transcript untuk pengujian dan fallback demo yang eksplisit bila jaringan/STT cloud bermasalah.

### Non-goals

- Tidak mentranskripsi pengumuman PA/speaker armada atau halte; scope hanya orang yang berbicara langsung kepada pengguna.
- Tidak menggunakan inference on-device atau self-hosted Whisper/faster-whisper pada iterasi ini.
- Tidak membuat speaker identification, diarization, atau pemisahan banyak pembicara.
- Tidak menyimpan audio ambient/noise sebagai histori; yang disimpan hanya informasi transkripsi fungsional.
- Tidak mengejar partial transcript token-by-token atau latency produksi; akurasi tetap lebih penting daripada kecepatan.
- Tidak mengimplementasikan profil netra, mobilitas/kursi roda, Buddy Up!, atau wearable/IoT band.

## Capabilities

### New Capabilities

- `live-transcription`: Capture audio percakapan dan menampilkan hasil Cloud STT near-real-time.
- `transcript-history`: Histori transkrip 7 hari, flag simpan, dan cleanup otomatis.

### Modified Capabilities

Tidak ada; belum ada spesifikasi capability existing di repository.

## Impact

- Bergantung pada `demo-shell-and-data-foundation` untuk app shell, navigasi, SQLite, cleanup, WebSocket, dan konfigurasi deployment.
- Menambah dependency Cloud STT API dan kebutuhan environment variable untuk kredensial; secret tidak boleh masuk repository.
- Membutuhkan validasi manual di device Android nyata untuk microphone permission, koneksi, readability, dan histori.
- Dapat dikerjakan sebelum change journey selesai karena tidak bergantung pada dummy tracking/incident feed.
