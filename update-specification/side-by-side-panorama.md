# Side by Side Panorama 360° Beranotasi (Daksa + Netra)

## Status
Draft

## Ringkasan
Ganti placeholder "Pratinjau 360°" di `SideBySidePage.tsx` dengan **viewer panorama 360° beranotasi** yang menampilkan foto 360° stasiun (1-2 stasiun major: Bundaran HI + Senayan) dengan overlay label fasilitas aksesibilitas yang muncul sesuai arah pandang. Profil **Daksa** (visual): navigasi via tombol panah kiri/kanan + chips fasilitas; profil **Netra** (verbal): daftar verbal + TTS (sudah ada, tetap).

## Latar Belakang & Masalah
- `SideBySidePage.tsx` L180-182 saat ini hanya menampilkan `<span class="sbs-visual-label">Pratinjau 360°</span>` (div placeholder statis, tanpa gambar asli).
- Kebutuhan: pengguna Daksa perlu melihat kondisi stasiun secara visual untuk merencanakan rute (ramp, lift, guiding block), dengan cara yang tidak memerlukan drag (aksesibilitas motorik).
- Data facility sudah ada per stop (`backend/facilities.py`, `FACILITY_ORDER`), dan endpoint `/api/facilities/stops` sudah live.

## Hasil Riset

### Kandidat approach untuk viewer panorama
| Kandidat | Trade-off |
|---|---|
| **A. CSS scroll panorama** (foto panorama wide, overflow-x scroll + snap, chips sebagai anak absolut di track) | Tanpa library/WebGL; sangat ringan (~0KB); touch inertia + keyboard panah gratis; chips ikut geser secara natural; navigasi via tombol panah (scrollBy) untuk aksesibilitas; equirectangular muncul distorsi vertikal (crop center band atau pakai cylindrical); bundle 0 dep baru |
| B. Pannellum (WebGL) | Ringan (~21KB gzipped); equirectangular benar; hotspots pitch/yaw; tapi WebGL diperlukan (beban + fallback CSS3D); perlu embed via useRef (tanpa React wrapper resmi) |
| C. Photo-Sphere-Viewer v5 (+@photo-sphere-viewer/react + MarkersPlugin) | Fitur annotation terkaya (markers yaw/pitch, tooltip); tapi ~150KB gzipped (Three.js + core); WebGL berat; overkill untuk 1-2 stasiun |
| D. egjs-view360 (CSS3D mode, tanpa WebGL) | ~35KB; CSS3D mode tanpa WebGL; hotspots; tapi kurang ter-maintain untuk React 19 |

**Keputusan: A — CSS scroll panorama.** Justifikasi: (1) tanpa dependensi baru (deterministik demo, bundle tidak bertambah); (2) aksesibilitas Daksa via tombol panah (scrollBy step 45°) tanpa perlu drag; (3) chips sebagai anak absolut di track ikut geser natural dengan panorama; (4) keyboard arrow keys gratis via native scroll; (5) untuk 1-2 stasiun, foto cylindrical atau multi-angle lebih mudah dibuat daripada equirectangular (cukup mode Pano HP atau beberapa foto sudut); (6) degradasi sempurna bila gambar gagal dimuat (fallback ke placeholder existing).

### Format gambar
- **Cylindrical pano** (mode Pano HP, single file wide): scroll horizontal natural, tanpa distorsi pole, mudah dibuat dengan ponsel di stasiun. **Atau multi-angle** (4-6 foto kompas N/E/S/W) dengan snap per slide. Kedua opsi ini lebih realistis untuk demo daripada equirectangular (yang butuh kamera 360° atau stitching).
- Gambar di-bundle di `frontend/public/` (deterministik, offline-capable, PWA-cacheable).

### Overlay annotation
- Chip fasilitas diposisikan absolut di track scroll: `left = (yaw/360) * 100%` — ikut geser dengan panorama secara natural.
- Visibilitas label (mis. "Ramp — Tersedia") muncul saat yaw chip dalam ±FOV/2 dari yaw pandang: `|angularDistance(chipYaw, viewYaw)| < fov/2`.
- Sumber yaw per fasilitas: konfigurasi per stasiun (data buatan realistis untuk demo, 1-2 stasiun).

## Keputusan Teknis
- **CSS scroll panorama** (tanpa library): komponen React baru `PanoramaFacilities` di file baru `frontend/src/PanoramaFacilities.tsx` (pola file baru seperti CameraScan/NetraScan — guard-safe).
- **Tombol panah kiri/kanan** untuk navigasi (scrollBy step ~45°), dengan haptic `navigator.vibrate(10)` per step (aksesibilitas + demo Android).
- **Chips fasilitas** berbasis yaw dari konfigurasi per stasiun; label muncul saat dalam view.
- **Gambar cylindrical pano** per stasiun di `frontend/public/panorama/` (deterministik, di-bundle); fallback ke placeholder existing bila gambar tidak ada.
- **Netra verbal** tetap seperti sekarang (daftar + TTS) — panorama tidak relevan untuk Netra (mereka tidak melihat), tapi verbal renderer sudah lengkap.

## Rancangan Spesifikasi Teknis

### Data model
Konfigurasi panorama per stasiun (file baru `frontend/src/panoramaConfig.ts` atau di SideBySidePage):
```ts
interface PanoramaConfig {
  stopId: string
  imageUrl: string          // e.g. '/panorama/bundaran-hi.jpg'
  chips: Array<{ facility: keyof FacilityStop['facilities']; yaw: number }> // yaw 0..360 derajat
}
```
Hanya untuk stasiun yang ada gambarnya (Bundaran HI + Senayan awalnya; stasiun lain → placeholder existing).

### Komponen `PanoramaFacilities` (file baru)
- Props: `{src: string, chips: Array<{facility, yaw}>, stopName: string}`
- Track scroll horizontal (`overflow-x: scroll`, `scroll-snap-type: x mandatory` opsional) dengan gambar wide (height ~200px, width ~300%).
- Chips: `<div>` absolut di track, `left: (yaw/360)*100%`, class `pano-chip pano-chip--on/off`.
- `viewYaw` state: dihitung dari `scrollLeft` (degPerPx = 360/scrollWidth).
- Tombol `‹` `›`: `scrollBy({left: ±step, behavior: 'smooth'})` + `navigator.vibrate?.(10)`; step = 45° dalam piksel.
- `aria-live` region: "Menghadap ke: {arah} — {fasilitas terdekat}" untuk aksesibilitas.
- `IntersectionObserver` atau scroll listener untuk menandai chip aktif (yang dalam view) — `pano-chip--active`.
- Error loading gambar → fallback `sbs-stop-card__visual` existing ("Pratinjau 360°").

### SideBySidePage.tsx — integrasi
- Renderer daksa (L168-199): ganti div `sbs-stop-card__visual` placeholder dengan `<PanoramaFacilities src={config.imageUrl} chips={config.chips} stopName={stop.name} />` bila konfigurasi panorama ada untuk stop tersebut; kalau tidak → placeholder existing.
- Tambah lookup konfigurasi: `getPanoramaConfig(stop.id): PanoramaConfig | null`.

### Gambar
- `frontend/public/panorama/bundaran-hi.jpg` + `senayan.jpg` (cylindrical, ~2400x400px, dibuat dari mode Pano HP di stasiun atau placeholder buatan).

### CSS
- `.pano-track`, `.pano-chip`, `.pano-chip--on/--off/--active`, `.pano-nav-btn` (absolute kiri/kanan, 44px), token `--brand-*` (tidak ada warna hardcode).

## Edge Case & Failure Handling
- **Gambar tidak ada / gagal dimuat** → fallback ke placeholder `sbs-stop-card__visual` existing.
- **Stasiun tanpa konfigurasi panorama** → placeholder existing.
- **Chip di luar view** → tidak ditandai aktif (normal).
- **Aksesibilitas motorik** → tombol panah 44px (tidak perlu drag); keyboard arrow keys via native scroll.
- **prefers-reduced-motion** → smooth scroll behavior normal (tidak dipaksa smooth).

## Testing Plan
- **Frontend**: `npm run check` + `sidebyside-check.mjs` exit 0 (kontrak dual renderer tidak berubah); komponen baru tidak merusak build.
- **Manual QA** (Android, profil Daksa): buka Side by Side → Bundaran HI → panorama muncul → tombol panah → geser → chips muncul sesuai arah; Netra → verbal tetap (daftar + TTS).
- **Gambar placeholder**: verifikasi tampil di 2 stasiun; stasiun lain → fallback.

## Risiko & Mitigasi
- **Gambar belum ada (belum difoto di stasiun)** → mitigasi: fallback placeholder; gunakan placeholder buatan sementara; tidak blokir fitur.
- **Distorsi equirectangular** → mitigasi: pakai cylindrical pano atau multi-angle (keputusan A).
- **Bundle gambar besar** → mitigasi: cylindrical ~2400x400px JPEG ~200-400KB per stasiun, 2 stasiun = <1MB total (OK untuk PWA precache atau lazy load).

## Referensi
- `frontend/src/SideBySidePage.tsx` (dual renderer, FacilityStop, placeholder 360°)
- `backend/facilities.py` (FACILITY_STOPS, FACILITY_ORDER)
- `backend/api/routers/facilities.py` (`/api/facilities/stops`)
- MDN scroll-snap: https://developer.mozilla.org/en-US/docs/Web/CSS_scroll_snap
- `frontend/src/NetraScan.tsx` (pola text twin + TTS)
