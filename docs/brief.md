# Transense — Project Brief

> Konteks hasil ekstraksi dari sesi diskusi panjang. Ditulis untuk AI coding agent yang belum pernah tahu proyek ini.
> Penanda: **[FINAL]** = sudah diputuskan owner. **[SARAN — BELUM DIKONFIRMASI]** = usulan asisten, owner belum memutuskan.

---

## Masalah & target user

**Target user (iterasi ini): HANYA penyandang Tuli/tunarungu.**

- Konteks: pengguna transportasi umum Jakarta, terutama TransJakarta.
- Divalidasi lewat wawancara 2 narasumber Tuli (komunitas GERKATIN). Ini satu-satunya profil disabilitas yang sudah tervalidasi langsung.

**Masalah yang tervalidasi dari wawancara:**

- Pengumuman di halte/armada TransJakarta hanya berupa **audio** → tidak bisa diakses sama sekali.
- Running text ada, tapi **terhalang orang saat berdesakan** → informasi hilang.
- **Tidak ada informasi darurat/keterlambatan** (kecelakaan, gangguan layanan). Narasumber tidak bisa tahu apa yang terjadi.
- **Halte kecil TransJakarta tidak punya monitor informasi** kedatangan. Halte besar (ada JPO) relatif aman.
- Jadwal di aplikasi resmi TJ dinilai **tidak akurat lagi** ("dulu bagus, sekarang tidak akurat") → narasumber akhirnya pakai jadwal buatan sendiri.
- Aplikasi transkripsi umum yang sudah dipakai narasumber **gagal saat sinyal jelek**, dan rawan miskomunikasi.

**Perbandingan antar-moda menurut narasumber (penting untuk framing):**

- **MRT = terbaik** — ada monitor besar, informasi lokasi jelas.
- **Whoosh = baik** — delay dinyatakan eksplisit dalam menit.
- **TransJakarta = terlemah** — bergantung audio, papan informasi kurang, sering terlambat.
- → TransJakarta dipilih justru karena paling bermasalah.

**Konteks tambahan dari wawancara (belum jadi fitur):**

- Ada kartu tap-in gratis khusus disabilitas dari **Bank DKI**, didaftarkan di kantor pusat TransJakarta, perpanjangan tiap 6 bulan, hanya berlaku di Jakarta.
- Preferensi UI: alur **lurus/linier, jangan berbelok-belok** ("pusing kalau belok-belok"). Ada perbedaan generasi — pengguna muda lebih toleran UI kompleks, pengguna tua lebih suka simpel.
- Preferensi layout: tampilan memanjang ke bawah, jadwal & tujuan langsung terlihat.
- Media sosial yang dipakai komunitas: Facebook, Instagram, TikTok.

---

## Fitur Utama vs Fitur Sampingan

**Prinsip pembagian:** fitur utama = wajib ada dan berfungsi di demo 14 Agustus. Fitur sampingan = boleh berupa mockup/simulasi/placeholder, atau ditunda ke iterasi berikutnya.

### FITUR UTAMA (mandatory, harus fungsional saat demo)

**1. Jadwal & tracking posisi armada TransJakarta**
- [FINAL] Naik status dari pelengkap jadi wajib — alasan: ketidakakuratan jadwal adalah keluhan utama di wawancara.
- Untuk demo: **posisi/jadwal boleh dummy/simulasi**, tidak wajib integrasi API riil TransJakarta (API belum diamankan).
- Real-time via WebSocket (FastAPI) ke frontend PWA.
- Sumber data ini juga jadi basis untuk notifikasi "armada mendekat" di fitur 3 — bukan dideteksi lewat computer vision (lihat fitur CV yang dihapus di "Non-goals").

**2. Transcribe — transkripsi percakapan orang (live transcript)**
- [FINAL] Prioritas akurasi di atas kecepatan — langsung dari feedback wawancara ("Tepat semuaaaaaaaaaaaa").
- **[FINAL] Scope: transkripsi orang yang bicara (arahkan HP ke lawan bicara — petugas, orang lain), BUKAN transkripsi pengumuman PA/speaker armada-halte.** Pengumuman resmi (keterlambatan, insiden) sudah ditangani via notifikasi terstruktur (fitur 3b) — transkripsi PA akan duplikat, jadi dihapus. Ini resolve pertanyaan "sumber audio" yang sebelumnya belum diputuskan: sumbernya mikrofon HP diarahkan ke orang, bukan integrasi sistem pengumuman armada.
- Use case: komunikasi langsung dengan petugas/orang lain saat butuh bantuan verbal, konsisten dengan temuan wawancara bahwa narasumber sudah terbiasa pakai app transkripsi serupa untuk komunikasi harian.
- **[FINAL] Histori transkrip tersimpan hingga 7 hari, bisa dibaca ulang.** Dari wawancara: narasumber ingin transkrip "bisa di-save lama". Hanya info fungsional yang disimpan — transkripsi suara ambient (angin, suara sekitar, dll) **tidak** disimpan, sesuai preferensi narasumber lain di wawancara yang sama ("yang penting-penting aja... angin kayaknya gaperlu").
- Implikasi teknis: perlu penyimpanan persisten (bukan cuma in-memory/state sesi), dengan mekanisme pembersihan otomatis data >7 hari, kecuali user memberi flag "simpan ini" pada transkrip tertentu (pengecualian dari auto-delete).

**3. Notifikasi real-time (dua jenis, terpisah dari live transcript)**

- **[FINAL] 3a. Notifikasi posisi/status perjalanan** — armada mendekat, halte tujuan mendekat. Sumber data: fitur 1 (jadwal & tracking), bukan deteksi visual.
- **[FINAL] 3b. Notifikasi resmi keterlambatan/insiden** — konten terstruktur, bukan cuma "armada terlambat". Owner memberi contoh referensi: push notification KAI Commuter Line (KRL) untuk delay/gangguan.
  - Format rujukan: judul ringkas status ("KA 1331 telah selesai pengecekan"), isi menjelaskan **penyebab** (pengecekan rangkaian, insiden, dll), **tindakan yang diambil** (kereta pengganti, jalur bergantian), dan **instruksi ke pengguna** (ikuti arahan petugas). Update dikirim bertahap seiring perkembangan situasi, bukan notifikasi tunggal.
  - Sumber: **resmi/ofisial** — bukan crowdsourced atau hasil deteksi sistem sendiri. Untuk demo, sumber ini disimulasikan (dummy feed insiden), karena integrasi API resmi TransJakarta belum ada.
  - Insight penting: notifikasi KAI Commuter ini **sudah berbasis teks dari awal** (push notification standar), jadi secara default sudah accessible untuk Tuli. TransJakarta belum punya sistem setara — audio-only untuk info ini di lapangan. Ini penajaman langsung dari temuan wawancara ("Gaada informasi keterlambatan jadwal, kayak kecelakaan dll — harusnya ada notifikasi") dan memperkuat alasan pemilihan TransJakarta sebagai pilot (moda paling tertinggal soal ini dibanding KRL).
  - Implikasi teknis: butuh sumber data status gangguan (dummy/simulasi untuk demo), dan struktur data notifikasi minimal: status, penyebab, tindakan, instruksi, timestamp update.
- **[FINAL] Setiap jenis notifikasi punya pola getar khas (distinct vibration pattern), bukan satu getar generik untuk semua.** Dari wawancara: narasumber menyatakan bisa membedakan pola getar pendek-panjang/berulang tanpa perlu melihat layar dulu, dan secara terpisah meminta pola getar khusus saat *salah arah* ketika navigasi jalan kaki di dalam halte.
  - Minimal 3 pola berbeda yang perlu didefinisikan: (1) armada mendekat, (2) halte tujuan mendekat, (3) notifikasi keterlambatan/insiden resmi (3b) — mengingat wawancara menekankan info darurat harus terasa berbeda dari notifikasi rutin.
  - **[SARAN — BELUM DIKONFIRMASI]** pola getar untuk "salah arah navigasi jalan kaki" kemungkinan pola ke-4 tersendiri — tapi fitur navigasi jalan kaki di dalam halte itu sendiri belum ada di scope manapun di brief ini (tidak termasuk fitur 1-3), jadi perlu diputuskan apakah ini masuk iterasi sekarang atau ditunda.
  - Spesifikasi pola getar konkret (durasi, jeda, pengulangan per jenis) — **belum diputuskan**, perlu divalidasi ulang ke narasumber idealnya dengan prototipe nyata, bukan dirancang di meja.
- **Penyampaian 3a & 3b sama-sama via visual + getar**: [FINAL] Getar via Vibration API — **hanya berfungsi di Android**, lihat constraint teknis. Device demo wajib Android. Visual: teks besar, kontras tinggi, kilat tepi layar — prinsip desain dari sesi wireframe sebelumnya (dirancang audio-blind sejak awal karena target user Tuli, bukan toggle warna dari mode lain).
- **[FINAL] Feed/history notifikasi keterlambatan (3b) juga tersimpan 7 hari** — disamakan dengan retensi transkrip di fitur 2, bukan 3 hari seperti draf userflow awal.

**4. Antar Aku — lapisan integrasi pendamping perjalanan**
- **[FINAL] Naik status jadi fitur utama.** Ini bukan fitur berdiri sendiri secara data — ia mengintegrasikan fitur 1 (tracking) dan fitur 3 (notifikasi) jadi satu pengalaman perjalanan utuh, dari berangkat sampai sampai tujuan.
- Alasan owner: pengguna Tuli mendapat pengalaman setara "orang biasa yang well-informed" via HP mereka sepanjang perjalanan — bukan harus buka-tutup beberapa fitur terpisah untuk tahu status perjalanan.
- Alur: user input tujuan → sistem cocokkan **halte TJ terdekat dari lokasi user** sebagai asal, dan **halte TJ terdekat dari tujuan** sebagai destinasi → sistem gambar rute di peta dari asal ke tujuan → user mengikuti rute tsb.
- Sepanjang perjalanan, terintegrasi otomatis: notifikasi armada mendekat (3a), notifikasi keterlambatan/insiden resmi (3b), dan **peringatan kalau user keluar dari rute yang ditentukan**.
- **Implikasi teknis baru** (di luar kapabilitas fitur 1 & 3 yang sudah didefinisikan):
  - **Routing halte-ke-halte**: pencocokan destinasi bebas (input user) ke halte TJ terdekat, lalu penggambaran rute di peta.
  - **Deteksi keluar-rute**: perlu tracking **posisi live user sendiri** (bukan cuma posisi armada), dibandingkan terus-menerus dengan jalur rute yang sudah digambar, untuk memicu peringatan deviasi. Ini kapabilitas baru — geolocation browser (Geolocation API) + logika perbandingan posisi-terhadap-rute.
  - **[FINAL] Deteksi keluar-rute: mock/simulasi untuk demo 14 Agustus, bukan implementasi teknis penuh.** Tidak perlu geolocation real + logika perbandingan posisi-terhadap-rute yang akurat. Cukup dipicu manual/skenario terkontrol saat rekaman video (mis. tombol debug "simulasikan keluar rute", atau state yang di-trigger dari mock data) untuk menunjukkan bagaimana peringatannya tampil ke user. Implementasi geolocation real bisa menyusul di iterasi setelah proposal, bukan prioritas sekarang.

### FITUR SAMPINGAN (nice-to-have, boleh mockup/simulasi/ditunda)

**5. Side by Side — peta aksesibilitas fasilitas (Gaussian Splatting / foto 360°)**
- [FINAL] Status diturunkan jadi nice-to-have saat scope dipangkas ke profil Tuli.
- Alasan: fitur ini awalnya dirancang dengan keluaran ganda per profil (3D visual untuk kursi roda, peta verbal audio untuk netra). Keduanya kini di luar scope — netra dihapus total dari produk, mobilitas juga tidak dalam scope Tuli-only. Justifikasi fitur ini untuk audiens Tuli-only **lemah** dan belum tervalidasi wawancara.
- Untuk demo: cukup mockup/wireframe, tidak perlu implementasi fungsional.
- Keputusan teknologi (Gaussian Splatting titik prioritas vs foto 360°) — **belum diputuskan**, dan tidak mendesak karena statusnya nice-to-have.

### DIHAPUS DARI SCOPE (bukan sampingan, benar-benar tidak dibangun)

- Buddy Up! (lihat "Non-goals")
- Perangkat wearable/IoT band (lihat "Non-goals")
- **[FINAL] Semua fitur profil netra**, termasuk deteksi armada via computer vision + OCR nomor koridor & panduan arah pintu berbasis kamera. Fitur-fitur ini awalnya dirancang khusus untuk pengguna yang tidak bisa melihat armada/pintu sama sekali — tidak relevan untuk profil Tuli (yang bisa melihat normal). Dengan profil netra dihapus total dari scope produk, seluruh use case fitur ini hilang.

---

## Keputusan yang SUDAH final

- **[FINAL] Nama produk: Transense.** Sebelumnya "TUNAKU"/"Pendamping Akses Transum". Diganti karena scope dipersempit ke satu fitur inti.
- **[FINAL] Userflow tingkat tinggi**: Onboarding (Login → atur cara menerima informasi → isi nama) → Beranda (search bar + peta real-time + 4 entry point: Antar Aku, Transcribe, Informasi Keterlambatan Jalur, Jadwal TransJakarta) → Profil (foto, identitas, preferensi notifikasi). Sumber: userflow Excalidraw yang dibuat owner.
- **[FINAL] Fokus hanya profil Tuli.** Alasan: baru profil ini yang tervalidasi lewat wawancara langsung. Profil netra & mobilitas dipangkas sampai ada validasi serupa.
- **[FINAL] Semua fitur profil netra dihapus total** (bukan cuma dipangkas sementara) — computer vision deteksi armada, OCR nomor koridor, panduan arah pintu. Konsekuensi: Side by Side kehilangan salah satu justifikasi keluaran gandanya (lihat "Yang masih terbuka").
- **[FINAL] Notifikasi dipecah jadi dua jenis eksplisit, terpisah dari live transcript**: (a) posisi/status perjalanan berbasis data tracking (fitur 1), dan (b) keterlambatan/insiden resmi berformat terstruktur ala KAI Commuter (status, penyebab, tindakan, instruksi).
- **[FINAL] Fitur Buddy Up! DIHAPUS.** Alasan dari wawancara: pengguna Tuli menilai tidak terlalu perlu — "lebih enak nyamperin langsung, kalau tatap muka lebih enak", dan tidak nyaman menunggu relawan yang jauh. Narasumber justru menyatakan fitur ini lebih relevan untuk **kombinasi disabilitas** (Tuli-Netra, Tuli-Daksa), bukan Tuli tunggal.
- **[FINAL] Side by Side (peta aksesibilitas 3D Gaussian Splatting) tetap ada, tapi statusnya "nice to have"**, bukan fitur inti.
- **[FINAL] Jadwal akurat + tracking posisi armada TransJakarta = fitur MANDATORY.** Ini naik status dari pelengkap jadi wajib, karena wawancara menunjukkan ketidakakuratan jadwal adalah keluhan utama.
- **[FINAL] Akurasi > kecepatan untuk transkripsi.** Langsung dari wawancara ("Tepat semuaaaaaaaaaaaa"). Tidak perlu di-trade-off lagi.
- **[FINAL] Phone-only.** Perangkat wearable/IoT band dihapus dari scope ("fokus ke handphone aja dulu").
- **[FINAL] Data awal boleh dummy/seed/simulasi.** Alasan: mengejar submit proposal 14 Agustus. Integrasi API riil menyusul.
- **[FINAL] Pengembangan lanjutan pakai spec-driven development via OpenSpec.**
- **[FINAL] Lokasi pilot: TransJakarta, Jakarta.**

---

## Alternatif yang SUDAH ditolak

Urutan kronologis eksplorasi ide. Semua ditolak owner, bukan asisten.

- **Platform navigasi & kesiapan faskes berbasis 3D (ide awal, "TUNAKU" versi rumah sakit)** — ditolak karena ditemukan **Straightline** (DiamondHacks 2026, Devpost + GitHub publik) yang konsepnya nyaris identik: Gaussian Splatting per lokasi + anotasi aksesibilitas di koordinat 3D + pengalaman pra-kunjungan + verifikasi kriteria aksesibilitas via agen AI. Risiko orisinalitas terlalu tinggi.
- **Memperluas ide faskes-3D ke semua fasilitas umum** — ditolak karena memperbesar masalah scalability (biaya capture per lokasi tidak turun), bukan menyelesaikannya.
- **Sistem peringatan dini & evakuasi bencana multi-modal untuk disabilitas** — ditolak owner: overhead implementasi terlalu besar (pemasangan node fisik, pelatihan warga, maintenance) sementara aplikasinya hanya dipakai saat kejadian genting. Rasio effort-to-usage buruk.
- **Marketplace juru bahasa isyarat (JBI) on-demand** — ditolak owner: kurang realistis (cold start marketplace dua sisi) dan kurang memanfaatkan teknologi (pada dasarnya marketplace manusia).
- **CCTV deteksi & pelacakan pelaku kejahatan / tabrak lari (ekstraksi plat, tracking lintas kamera)** — ditolak: keluar dari tema disabilitas, dan asisten menolak mengembangkan kemampuan pelacakan individu otomatis karena risiko penyalahgunaan surveillance. Referensi yang dipakai owner (SafeTrip) sendiri secara eksplisit menghindari face recognition dan mewajibkan human review.
- **Crowdsourced verification infrastruktur aksesibilitas + dashboard dinas** — ditolak owner: terlalu government-centered / berbasis DSS. Warga hanya jadi sumber data, tidak dapat manfaat langsung.
- **Dashboard kepatuhan kuota kerja disabilitas 2%** — ditolak: government-centered, teknologi kurang dalam.
- **Sistem pendataan terpadu disabilitas untuk kebijakan** — ditolak: government-centered.
- **Navigasi "rute aman harian" untuk pejalan kaki disabilitas** — ditolak owner: terlalu dekat dengan Wheelmap / Google Maps wheelchair routing yang sudah ada global, hanya beda granularitas.
- **IoT band untuk relawan** (bergetar saat ada permintaan bantuan terdekat) — ditolak: skalabilitas terbalik (makin sukses makin banyak unit harus diproduksi), dan redundan karena relawan adalah pengguna non-disabilitas dengan HP normal.
- **IoT band untuk pengguna** (reposisi dari usulan di atas) — sempat disetujui dengan justifikasi ergonomi & atensi, lalu **dihapus owner** untuk fokus phone-only.

---

## Stack & constraint teknis

**Yang sudah ditentukan (level kapabilitas, bukan framework):**

- Speech-to-text real-time untuk transkripsi pengumuman audio.
- Validasi silang dengan API resmi operator TransJakarta (posisi armada, jadwal, koridor).
- Notifikasi visual (teks besar, kontras tinggi, kilat tepi layar) + haptic.

**Constraint:**

- **Deadline proposal: 14 Agustus 2026.** Hari ini 9 Agustus 2026 → tersisa ~5 hari.
- **Target: aplikasi bisa didemokan langsung di video submission 14 Agustus** — bukan cuma mockup statis.
- Akses API TransJakarta **belum diamankan**. Untuk tahap ini pakai dummy/seed data.
- Tim mahasiswa, resource terbatas.
- Kompetisi: GEMASTIK XIX 2026, divisi Kota Cerdas. HKI wajib bagi finalis. Ada lampiran wajib Pernyataan Transparansi Penggunaan AI.

**[FINAL] Stack:**

- **Frontend: PWA.** Alasan owner: cepat dibangun, cepat didemokan ke juri tanpa instalasi lewat store — cukup buka link.
- **Backend: FastAPI** (atau setara yang cepat dikembangkan). Cocok untuk WebSocket native (update posisi armada real-time, streaming transkripsi) dan ekosistem Python untuk integrasi STT.
- **[FINAL] Jika lolos final: bungkus PWA dengan CapacitorJS → jadi Android app.** Tidak menulis ulang aplikasi, hanya membungkus WebView + jembatan plugin native. Ditunda sampai lolos final untuk menghindari sunk cost kalau tidak lolos.
- **[FINAL] Target device demo: Android, bukan iOS/iPhone.** Alasan teknis (lihat constraint di bawah) — ini juga selaras dengan rencana Capacitor yang menargetkan Android.

**Constraint teknis kritis — Vibration API tidak berfungsi di iOS/Safari:**

- `navigator.vibrate()` **tidak didukung sama sekali** di Safari desktop maupun iOS — bukan keterbatasan sementara, memang tidak diimplementasikan WebKit. Dukungan browser global untuk API ini ±77% karena pengecualian Safari.
- **Konsekuensi langsung:** notifikasi getar untuk profil Tuli — salah satu output inti Transense — tidak akan berfungsi kalau didemokan di iPhone.
- **Mitigasi yang sudah diputuskan:** device untuk rekaman video demo 14 Agustus harus Android. Device tim yang iPhone tidak bisa dipakai untuk demo fitur getar.
- Push notification PWA di iOS juga bermasalah (baru jalan iOS 16.4+, di luar EU) — bukan blocker untuk konteks Indonesia, tapi menguatkan keputusan Android-first untuk seluruh fitur notifikasi.

**BELUM DIBAHAS sama sekali:**

- Database, hosting/deployment untuk demo.
- Model/library spesifik untuk STT (mis. cloud API vs self-hosted Whisper/faster-whisper).
- On-device vs cloud inference.
- Arsitektur repo, testing strategy, CI.
- Framework frontend spesifik untuk PWA (React/Vue/Svelte/vanilla).

---

## Scope iterasi pertama

Untuk mengejar submit proposal 14 Agustus:

- Transcribe: transkripsi orang bicara (arahkan HP ke lawan bicara) → teks, dengan histori tersimpan 7 hari. **Prioritas: akurasi, bukan kecepatan.**
- Tampilan jadwal + tracking posisi armada TransJakarta (mandatory).
- Notifikasi real-time visual + getar — dua jenis: (a) posisi/status perjalanan (armada mendekat, halte tujuan mendekat), dan (b) keterlambatan/insiden resmi, format terstruktur ala KAI Commuter. Tiap jenis punya pola getar khas sendiri. Feed 3b tersimpan 7 hari.
- **Antar Aku**: routing dari lokasi user ke halte TJ terdekat tujuan, rute di peta, integrasi notifikasi otomatis sepanjang perjalanan, peringatan keluar-rute.
- Semua data boleh **dummy/simulasi** — integrasi API riil belum wajib di iterasi ini.
- Mockup/wireframe untuk bagian "Screenshot Mockup Aplikasi" di proposal.
- **Aplikasi berjalan dan bisa direkam sebagai video demo pada 14 Agustus** (bukan cuma proposal tertulis + mockup statis).
- Rekaman demo video wajib pakai device Android (lihat constraint Vibration API).

**Permintaan fitur dari wawancara yang masih di luar scope 3 fitur utama** (owner belum memutuskan masuk iterasi mana):

- **Navigasi jalan kaki di dalam halte** (dengan pola getar khusus saat salah arah) — ini permintaan terpisah dari notifikasi transum. Belum ada fitur navigasi-dalam-halte di scope manapun di brief ini; kalau mau dibangun, ini fitur baru, bukan tambahan ke fitur 1-3.

---

## Non-goals (sengaja TIDAK dibangun)

- **Buddy Up! / sistem bantuan relawan** — dihapus dari scope.
- **Perangkat wearable / IoT band** — dihapus, phone-only.
- **Profil netra — dihapus total dari produk.** Bukan lagi "belum tervalidasi", tapi keputusan eksplisit: semua fitur turunannya (deteksi armada via computer vision, OCR nomor koridor, panduan arah pintu, peta verbal audio di Side by Side) ikut dihapus.
- **Profil mobilitas/kursi roda** — belum tervalidasi, di luar scope iterasi ini.
- **Profil disabilitas intelektual & Tuli-Netra (deafblind)** — di luar scope.
- **Pembangunan/perbaikan infrastruktur fisik** (ramp, guiding block, lift) — tetap tanggung jawab pengelola.
- **Pengukuran kepatuhan kuantitatif dari model 3D** (lebar pintu, kemiringan ramp). Alasan teknis: error geometris Gaussian Splatting ~7,8 cm (SD 11,5 cm) vs standar Permen PUPR yang butuh presisi sentimeter. Model 3D hanya untuk pengenalan ruang.
- **Cakupan seluruh jaringan halte kota** — rekonstruksi 3D hanya di titik prioritas.
- **Pelacakan/identifikasi individu via CCTV** — ditolak atas dasar etis.

---

## Yang masih terbuka / belum diputuskan

**Konsekuensi langsung dari pemangkasan scope (perlu keputusan owner):**

- **Pilar Smart People kehilangan dasar.** Di proposal, klaim Smart People bertumpu sepenuhnya pada Buddy Up! (warga jadi relawan). Buddy Up! sekarang dihapus → bagian 2.2 proposal perlu direvisi. Tersisa Smart Living (utama) + Smart Governance.
- **Justifikasi Side by Side sangat lemah untuk audiens Tuli-only, mungkin perlu dipertimbangkan ulang keberadaannya.** Fitur ini dirancang dengan keluaran ganda per profil (3D visual untuk kursi roda, peta verbal audio untuk netra) — profil netra kini dihapus total, profil mobilitas tidak dalam scope. Tidak ada persona tersisa yang menjadi target asli fitur ini. Wawancara juga tidak menghasilkan validasi apa pun (catatan mentah: "Ga ada review they just like it"). **[SARAN — BELUM DIKONFIRMASI]** pertimbangkan menurunkan lagi jadi murni placeholder proposal, atau hapus dari demo sepenuhnya.

**Keputusan teknis yang belum diambil:**

- Teknologi Side by Side: Gaussian Splatting terbatas di titik prioritas **vs** foto 360° beranotasi (lebih murah, lebih scalable).
- Halte TransJakarta spesifik untuk pilot — belum dipilih.
- Status akses API TransJakarta — belum ada, perlu strategi kalau tidak dapat.
- Integrasi kartu disabilitas Bank DKI (cek status, reminder perpanjangan 6 bulan) — muncul di wawancara, belum diputuskan jadi fitur.

**Gap riset:**

- Isu privasi lokasi belum tergali (pertanyaan diajukan di wawancara tapi jawaban tidak tercatat). Sebagian besar jadi moot karena Buddy Up! dihapus.
- Sampel wawancara baru 2 narasumber, keduanya Tuli. Belum ada validasi untuk profil lain.
- Transkrip wawancara mencampur jawaban 2 narasumber tanpa atribusi konsisten di beberapa bagian.
- Istilah "juru bahasa isyarat sentuh" (untuk Tuli-Netra) muncul di wawancara, belum didalami.