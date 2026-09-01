# Netra Voice Guide — Direct Turn-by-Turn Audio Guidance (Transit + Station Walk)

## Status
Draft

## Ringkasan
Tambahkan **voice guidance langsung (direct guide)** yang cepat dan efektif untuk profil **Netra** (tunanetra): (1) **Transit guidance** saat perjalanan (boarding, en route, transfer, destination approaching, off-route) — mengikuti pola Google Maps/OsmAnd dengan announcement stages + dedupe + priority; (2) **Station walk navigation** — perluasan `/api/vision/nav` dari one-shot button-triggered menjadi **continuous guidance dengan auto-poll + dedupe + session continuity**; fondasi bersama: **TTS priority queue** (mengatasi gap utama `tts.ts` yang tidak punya queue/interrupt).

## Latar Belakang & Masalah
- Transense sudah punya TTS one-shot (button press, notification baru) dan station nav one-shot (button "Navigasi ke peron"). Tidak ada **panduan berkelanjutan** — pengguna Netra tidak mendapat arahan aktif sepanjang perjalanan.
- **Gap utama** `frontend/src/tts.ts`: `speak()` tidak punya queue — concurrent calls membuat `Audio` elements **overlap** (dua suara bersamaan). Tidak ada cancel/interrupt. Tidak ada state machine untuk guidance.
- **Station nav** `/api/vision/nav` stateless + button-triggered + latency 12s — tidak kontinu.
- Kebutuhan: "direct guide yang cepat dan efektif" — voice cues aktif, actionable, tidak overwhelming.

## Hasil Riset

### Pola Google Maps voice guidance (OsmAnd/Mapbox/HERE/comaps)
- **4-tahap announcement** (HERE): `range` (terjauh) → `reminder` → `distance` → `action` (di titik). OsmAnd setara: `LONG_PREPARE_TURN` → `PREPARE_TURN` → `TURN_IN` → `TURN_NOW`, dengan `_END` distance per tahap agar tidak re-trigger.
- **Once-per-titik** (Mapbox PR #1263): setiap instruksi hanya dibacakan sekali per step (track `announced` per trigger).
- **Merge** (comaps `turns_notification_manager.cpp`): jika dua aksi <400m → gabung "…then…"; <50m → drop distance clause ("Then" saja).
- **Skip tahap dekat** (OsmAnd): skip "prepare" jika <150m sebelum "turn in"; lead distance speed-adaptive (vehicle 35–150m, pedestrian 15–25m; `POSITIONING_TOLERANCE = 12m`).
- **Off-route**: interrupt speech → alert reroute → instruksi baru (Mapbox `pauseSpeechAndPlayReroutingDing`); OsmAnd `OFF_ROUTE_DISTANCE = DEFAULT_SPEED * 20` (~22m pedestrian).
- **Cadence anti-overwhelm**: min gap antar prompt ~1.5s (Queue pump); warning berulang 120s repeat delay (OsmAnd speeding); max 1 approaching POI; tap-to-replay manual.

### TTS continuous patterns (Web Speech API vs ElevenLabs vs hybrid)
- **Web Speech API** (`speechSynthesis`): free, latency ~100-300ms (Android local voices), queue FIFO bawaan + `cancel()` global (tidak ada dequeue per-item — gap spec, BotFramework-WebChat #2568); Chrome bugs: `cancel()`→`speak()` race (~250ms), 200-300 char cutoff, mobile user-gesture unlock (volume-0 empty utterance pattern); kualitas < ElevenLabs tapi instant.
- **ElevenLabs proxy** (existing `/api/tts`): kualitas terbaik, Indonesian; latency 500ms-2s+; blob cache per normalized text di `tts.ts` (in-memory, hilang saat reload); biaya per karakter.
- **Hybrid (recommended)**: **pre-cache template prompts** (finite set — pola Mapbox `prepareIncomingSpokenInstructions`: pre-synthesize instruksi berikutnya saat sekarang diputar) via ElevenLabs untuk kualitas; **Web Speech API sebagai instant fallback tier** untuk konten dinamis belum ter-cache; **visible text fallback** (pola existing `onFallback`).
- **Priority queue** (pola intercept `voice-alerts.js`): LOW drop jika speaking, MEDIUM queue FIFO, HIGH cancel+interrupt ("turun sekarang" / off-route / destination).

### Existing Transense pipeline (explore)
- **`tts.ts`**: no queue, no interrupt — `speak()` overlap (BLOCKER utama untuk continuous guidance).
- **`JourneyTrackingPage.tsx`**: leg-by-leg GPS machine (legIndex, legPhase awaiting/onboard/arrived, geofence ARRIVED_M=100, APPROACHING_M=500, geofence advance) — **zero TTS** (Tuli-first); leg-mode data (WALK/BUS/RAIL) + stops + ETA — **hook point utama transit guidance**.
- **`TransitTrackingPage.tsx`**: `/api/journey/track` consumer, status transitions vibrate (dedupe lastAlert) — no TTS.
- **`PlannerPage.tsx`**: itinerary data (legs with mode/from/to/times/distance/route/headsign, transfers, walk_distance, total_minutes); TTS button-only; handoff ke JourneyTrackingPage; destination lifted via `onDestinationSelected` → NetraScan.
- **`journey.py` `/api/journey/track`**: status (unavailable/not_found/not_on_route/arrived/approaching/en_route), vehicle, route stops (ordered), target_stop, next_stop, eta_minutes (crude 300m/min).
- **`ai.py` `/api/vision/nav`**: stateless one-shot, 12s timeout, strict short instruction (max 20 kata, arah-first, safety-first).
- **`journey.ts`**: `VIBRATION_PATTERNS` contract (jangan diubah; direction haptics ad-hoc di NetraScan).
- **`notify.ts`**: per-profile output + speak-once-per-id dedupe.

## Keputusan Teknis
- **Fondasi**: **`GuidanceSpeechQueue`** di `frontend/src/guidance/speechQueue.ts` (atau `frontend/src/speechQueue.ts`) — priority queue (LOW drop / NORMAL FIFO / CRITICAL cancel+interrupt) + `minGapMs=1500` antara prompt + dedupe-by-text + never-throws + visible fallback via `onFallback` (pola `TtsProvider`).
- **Transit guidance**: `frontend/src/guidance/transitGuide.ts` (pure, node-testable seperti `approach.ts`) — state machine (idle → awaiting_boarding → boarding → en_route → transfer_walk → destination_approaching → arrived) + announcement plan (ETA-banded onboard, distance-banded walk) + dedupe sekali-per-trigger + reset flags on phase transition.
- **Walk guidance (stasiun)**: perluasan `NetraScan` dengan **auto-poll mode** saat `navActive` (pacing ≥12s sesuai latency `/api/vision/nav`) + instruction dedupe (skip identical answer) + arah haptic formalization (additive di `journey.ts` — hati-hati contract journey-check).
- **Pre-cache**: generate template prompts saat trip start via `/api/tts` (finite set dari itinerary) — pola Mapbox pre-cache; Web Speech API fallback untuk dinamis belum ter-cache.
- **Integrasi**: hooks di `JourneyTrackingPage` (leg transitions + geofence + ETA) + `TransitTrackingPage` (track status + next_stop) + `NetraScan` (walk nav continuity).

## Rancangan Spesifikasi Teknis

### Fondasi: `frontend/src/speechQueue.ts`
```typescript
export type GuidancePriority = 'low' | 'normal' | 'critical'
export interface QueuedPrompt { text: string; priority: GuidancePriority }

export class GuidanceSpeechQueue {
  private queue: QueuedPrompt[] = []
  private current: HTMLAudioElement | null = null
  private readonly minGapMs = 1500

  constructor(private readonly provider: TtsProvider) {}

  speak(text: string, priority: GuidancePriority = 'normal'): void {
    if (priority === 'low' && this.current) return          // drop
    if (priority === 'critical') {                           // interrupt
      this.current?.pause(); this.current = null; this.queue = []
    }
    if (this.queue.some(q => q.text === text)) return        // dedupe (Mapbox once-per-trigger)
    this.queue.push({ text, priority })
    if (!this.current) void this.pump()
  }

  private async pump(): Promise<void> {
    const next = this.queue.shift(); if (!next) return
    this.current = new Audio()  // placeholder — provider.speak handles playback
    await this.provider.speak(next.text)                     // resolves onended, never rejects
    this.current = null
    await new Promise(r => setTimeout(r, this.minGapMs))
    void this.pump()
  }
}
```
(Atau: extend `TtsProvider` dengan queue internal — pilih yang minimal merusak kontrak; guard `tts-check.mjs` memeriksa pola existing — tambah guard baru `speech-queue-check.mjs` untuk kontrak queue.)

### Transit guidance: `frontend/src/guidance/transitGuide.ts` (pure)
```typescript
export type GuidancePhase = 'idle' | 'awaiting_boarding' | 'boarding' | 'en_route' | 'transfer_walk' | 'destination_approaching' | 'arrived'

export interface PhaseTrigger {
  phase: GuidancePhase
  trigger: { etaMinutes?: number; stopsAway?: number; distanceM?: number }
  priority: GuidancePriority
  announced: boolean
}

// ANNOUNCEMENT_PLAN (ETA-banded onboard, distance-banded walk):
// awaiting_boarding: ETA 3 → "Bus koridor 1 tiba 3 menit lagi." (normal)
// awaiting_boarding: ETA 1 → "Bus tiba 1 menit lagi. Bersiap naik di depan." (critical)
// boarding: vehicle at stop → "Bus tiba. Silakan naik." (critical)
// en_route: stopsAway 2 → "Dua halte lagi: turun di X untuk ganti koridor Y." (low)
// en_route: stopsAway 1 → "Halte berikutnya: X." (normal)
// transfer_walk: → "Setelah turun, jalan 150 meter ke halte Transjakarta berikutnya." (normal)
// destination_approaching: ETA 2 → "Tujuan 2 halte lagi." (critical — interrupt)
// destination_approaching: ETA 1 → "Halte berikutnya tujuan Anda. Tekan tombol stop." (critical — interrupt)
// arrived: → "Anda telah tiba di tujuan." (critical)
// off_route: → "Anda tampak keluar dari rute. Rute dihitung ulang." (critical — interrupt)

export function advancePhase(state, event): { phase, prompt? }
export function shouldAnnounce(state, trigger, now): boolean  // dedupe + cooldown 120s warning
export function buildPrompt(template, data): string           // pure, deterministic, ≤20 kata, action-first
```
- **Progress cursor**: `(legIndex, stopIndex)` ke itinerary; advance saat `/api/journey/track` poll atau WS `notification.*` atau geofence (JourneyTrackingPage `ARRIVED_M=100`, `APPROACHING_M=500`).
- **Dedupe**: `announced: true` saat fire; reset fase berikutnya flags saat phase transition (Mapbox PR #1263).
- **Cooldown**: warning berulang (off-route) 120s repeat delay (OsmAnd).

### Walk guidance (stasiun): perluasan `NetraScan`
- **Auto-poll mode**: saat `navActive` true, interval ≥12000ms (sesuai latency `/api/vision/nav`) → POST `/api/vision/nav` dengan frame terakhir + `station_context` + `destination` + `leg_context` (opsional: leg info dari itinerary).
- **Instruction dedupe**: skip identical `instruction` dari respons (sama dengan sebelumnya) — jangan re-speak.
- **Arah haptic**: formalize direction patterns di `journey.ts` (additive — `VIBRATION_PATTERNS.directionLeft/Right/Forward/Stop` baru, JANGAN ubah existing 3 pola contract).
- **Session continuity**: kirim `previous_instruction` (opsional) agar Gemini tahu instruksi sebelumnya (hindari repetisi).

### Pre-cache template prompts
- Saat trip start (JourneyTrackingPage mount), generate template prompts untuk fase-fase (boarding, en_route template, destination, arrived) via `/api/tts` → cache blob URL (pola `tts.ts` cache). Ini menghilangkan latency untuk prompt umum.
- **Web Speech API fallback**: untuk prompt dinamis belum ter-cache (mis. ETA live), pakai `speechSynthesis` (Android local voice, instant ~100-300ms) — fallback instant tier sebelum visible text.

### Integrasi hooks
- **`JourneyTrackingPage.tsx`**: tambah prop `tts` (dari PlannerPage) + `profile`; mount `GuidanceSpeechQueue` (useMemo); speak on `legPhase` transitions, `advanceLeg()`, approach geofence (500m), ETA countdown (3/2/1 min), arrival; periodic reassurance "masih di rute, N halte lagi" dengan cooldown.
- **`TransitTrackingPage.tsx`**: speak on `track.status` transitions (approaching/arrived) + `next_stop` changes (di samping vibrate existing).
- **`NetraScan.tsx`**: auto-poll mode saat navActive + dedupe + arah haptic + session continuity.
- **`App.tsx`**: single `GuidanceSpeechQueue` instance (atau per-screen) via useMemo, pass `tts` ke JourneyTrackingPage.

### API backend (tidak ada perubahan — reuse existing)
- `/api/tts` (template pre-cache), `/api/journey/track` (transit data), `/api/vision/nav` (walk nav), `/api/transit/positions` (rail — opsional).

## Edge Case & Failure Handling
- **Overlap** → queue serialize + critical interrupt.
- **TTS gagal** → visible text twin (pola existing `onFallback`).
- **Off-route** → critical interrupt + reroute prompt (jangan stack dengan instruksi sebelumnya).
- **Repetisi** → dedupe-by-text + once-per-trigger + 120s cooldown warning.
- **Overwhelming** → minGapMs 1500 + max 1 approaching POI + skip tahap dekat (<150m skip prepare).
- **TTS cache unbounded** → template prompts finite; quantize ETA text (round ke menit) agar cache key reuse.
- **Chrome bugs** → `cancel()`→`speak()` race (~250ms delay), 200-300 char chunking (prompt ≤20 kata aman), mobile unlock (user gesture start tracking = gesture).
- **Key/feed hilang** → degrade: transit guidance fallback ke visible text; walk nav fallback_text.
- **Battery/background** → hanya aktif saat tracking/navActive; stop saat screen change/arrived.

## Testing Plan
- **Unit tests** (node): `speech-queue-check.mjs` (queue priority order, interrupt, dedupe, minGap); `guidance-check.mjs` (phase transitions, announcement plan, prompt builders ≤20 kata, dedupe, cooldown); `nav-continuity-check.mjs` (auto-poll pacing ≥12s, dedupe).
- **Frontend**: `npm run check` 0; guards existing 10 exit 0 (journey/transcribe/planner/planner-storage/profile-storage/tts/notify/camera/approach/sidebyside) — direction haptic additive di journey.ts (journey-check scan exact patterns — additive only).
- **Manual QA Android** (profil Netra): onboarding → Antar Aku → tracking → dengar transit guidance (boarding, en route, destination); stasiun → auto-poll walk nav → instruksi kontinu; off-route → interrupt; overlap tidak terjadi; battery tidak boros.

## Risiko & Mitigasi
- **Overlap audio** → priority queue + interrupt (pola intercept).
- **Prompt fatigue** → cadence (minGap, skip tahap dekat, cooldown, once-per-trigger).
- **Latency ElevenLabs** → pre-cache template + Web Speech API instant fallback.
- **Chrome bugs** → known workarounds (cancel race delay, chunking, unlock gesture).
- **Overwhelm Netra** → action-first, ≤20 kata, ≤2 kalimat, visible text twin selalu.
- **Cost** → pre-cache template finite; dynamic minimal; ElevenLabs flash model (opsional, lebih murah/cepat).

## Referensi
- Mapbox voice guidance: [`RouteVoiceController.swift`](https://github.com/mapbox/mapbox-navigation-ios/blob/v2.20.3/Sources/MapboxNavigation/RouteVoiceController.swift), PR #1263 (dedupe), Directions voiceInstructions schema (`distanceAlongGeometry`)
- OsmAnd: [`AnnounceTimeDistances.java`](https://github.com/osmandapp/OsmAnd/blob/master/OsmAnd/src/net/osmand/plus/routing/data/AnnounceTimeDistances.java) (tahap + lead distances + tolerance 12m), voice-prompt-triggering.md
- HERE SDK voice guidance (4 tahap): https://docs.here.com/here-sdk/docs/flutter-navigation-voice-guidance
- comaps turns_notification_manager.cpp (merge <400m, drop <50m)
- intercept voice-alerts.js (priority queue): https://github.com/smittix/intercept/blob/main/static/js/core/voice-alerts.js
- Web Speech API: MDN SpeechSynthesis + cancel(); BotFramework-WebChat #2568 (no dequeue per item); Chrome bugs (StackOverflow cancel race, 200-300 char cutoff); openchamber browserVoiceService.ts (mobile unlock pattern)
- Existing Transense: `frontend/src/tts.ts`, `frontend/src/approach.ts` (pola pure module), `frontend/src/JourneyTrackingPage.tsx`, `frontend/src/TransitTrackingPage.tsx`, `frontend/src/PlannerPage.tsx`, `frontend/src/NetraScan.tsx`, `frontend/src/notify.ts`, `frontend/src/journey.ts`, `backend/api/routers/journey.py`, `backend/api/routers/ai.py`
