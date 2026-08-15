/**
 * Side-by-side page: the SAME facility data rendered two ways, one per
 * accessibility profile — a VISUAL renderer for the daksa (physical mobility)
 * profile and a VERBAL + TTS renderer for the netra (blind) profile.
 *
 * The tuli profile renders nothing here: Tuli users interact with the app
 * through its default visual+haptic screens, so this page is only wired for
 * netra/daksa.
 *
 * Data contract: `GET /api/facilities/stops` returns `{ stops, source }`
 * where each stop is a `FacilityStop`. The payload carries normal facility
 * information (brief-v2 owner decision: presented as real data, no marker).
 * The 360° photo shown for daksa is an explicit static placeholder labeled
 * "Pratinjau 360°".
 *
 * The pure helpers (`isFacilityStop`, `buildStopAnnouncement`) are exported so
 * the deterministic wording can be unit-tested in node (see
 * sidebyside-check.mjs); the React component stays thin on top of them.
 */

import { useEffect, useState } from 'react'
import type { ProfileType } from './profile'
import type { TtsProvider } from './tts'

export interface FacilityStop {
  id: string
  name: string
  lat: number
  lng: number
  facilities: {
    ramp: boolean
    lift: boolean
    toilet_accessible: boolean
    guiding_block: boolean
    staffed: boolean
    step_free_access: boolean
  }
}

export interface SideBySidePageProps {
  apiBaseUrl: string
  profile: ProfileType
  tts?: TtsProvider
}

/** Canonical display order for the six accessibility facilities. */
const FACILITY_ORDER: ReadonlyArray<keyof FacilityStop['facilities']> = [
  'ramp',
  'lift',
  'toilet_accessible',
  'guiding_block',
  'staffed',
  'step_free_access',
]

/** Chip labels for the daksa (visual) renderer. */
const FACILITY_CHIP_LABELS: Record<keyof FacilityStop['facilities'], string> = {
  ramp: 'Ramp',
  lift: 'Lift',
  toilet_accessible: 'Toilet aksesibel',
  guiding_block: 'Guiding block',
  staffed: 'Staf',
  step_free_access: 'Step-free',
}

/** Indonesian spoken wording for the netra (verbal) renderer. */
const FACILITY_SPOKEN_LABELS: Record<keyof FacilityStop['facilities'], string> = {
  ramp: 'ramp',
  lift: 'lift',
  toilet_accessible: 'toilet aksesibel',
  guiding_block: 'guiding block',
  staffed: 'staf',
  step_free_access: 'akses tanpa langkah',
}

/**
 * Runtime type guard for a facility stop coming from the API. Rejects anything
 * that is not a complete object with the six boolean facility flags, so unknown
 * payloads degrade to the error/empty state instead of crashing the renderers.
 */
export function isFacilityStop(value: unknown): value is FacilityStop {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '' || typeof record.name !== 'string' || record.name === '') {
    return false
  }
  if (typeof record.lat !== 'number' || typeof record.lng !== 'number') return false
  if (typeof record.facilities !== 'object' || record.facilities === null) return false
  const facilities = record.facilities as Record<string, unknown>
  return FACILITY_ORDER.every((key) => typeof facilities[key] === 'boolean')
}

/**
 * Deterministic Indonesian announcement for one stop: the stop name followed by
 * the list of facilities that ARE available. Only available facilities are
 * mentioned (TTS reads exactly what a visual user would see highlighted).
 */
export function buildStopAnnouncement(stop: FacilityStop): string {
  const available = FACILITY_ORDER.filter((key) => stop.facilities[key])
  if (available.length === 0) {
    return `${stop.name}. Belum ada fasilitas aksesibilitas di halte ini.`
  }
  const list = available.map((key) => FACILITY_SPOKEN_LABELS[key]).join(', ')
  return `${stop.name}. Tersedia ${list}.`
}

type LoadStatus = 'loading' | 'ready' | 'error'

export default function SideBySidePage({ apiBaseUrl, profile, tts }: SideBySidePageProps) {
  const [stops, setStops] = useState<FacilityStop[]>([])
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [speakingStopId, setSpeakingStopId] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    fetch(`${apiBaseUrl}/api/facilities/stops`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = (await response.json()) as { stops?: unknown }
        const loaded = Array.isArray(payload.stops) ? payload.stops.filter(isFacilityStop) : []
        if (controller.signal.aborted) return
        setStops(loaded)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setStatus('error')
        console.warn('Transense could not load facility stops.', error)
      })
    return () => controller.abort()
  }, [apiBaseUrl])

  // The page is only wired for netra/daksa; tuli users use the default screens.
  if (profile === 'tuli') return null

  if (status === 'loading') {
    return (
      <div className="empty-state">
        <span className="empty-state__mark" aria-hidden="true">…</span>
        <h3>Memuat fasilitas halte…</h3>
        <p>Menunggu daftar halte dari server.</p>
      </div>
    )
  }

  if (status === 'error' || stops.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-state__mark" aria-hidden="true">!</span>
        <h3>Data fasilitas halte belum tersedia.</h3>
        <p>Coba lagi dalam beberapa saat.</p>
      </div>
    )
  }

  const handleSpeak = async (stop: FacilityStop): Promise<void> => {
    if (!tts) return
    setSpeakingStopId(stop.id)
    try {
      await tts.speak(buildStopAnnouncement(stop))
    } finally {
      setSpeakingStopId(null)
    }
  }

  // ---- Daksa renderer: visual 360° placeholder + facility chips ----
  if (profile === 'daksa') {
    return (
      <section className="sbs-page" aria-labelledby="sbs-heading">
        <div className="sbs-page__heading">
          <p className="eyebrow">FASILITAS HALTE</p>
          <h2 id="sbs-heading">Fasilitas halte</h2>
          <p className="sbs-page__intro">Lihat fasilitas aksesibilitas yang tersedia di setiap halte.</p>
        </div>
        <div className="sbs-list">
          {stops.map((stop) => (
            <article className="sbs-stop-card" key={stop.id}>
              <h3 className="sbs-stop-card__name">{stop.name}</h3>
              <div className="sbs-stop-card__visual" role="img" aria-label={`Pratinjau 360° ${stop.name}`}>
                <span className="sbs-visual-label">Pratinjau 360°</span>
              </div>
              <ul className="sbs-stop-card__facilities">
                {FACILITY_ORDER.map((key) => {
                  const available = stop.facilities[key]
                  return (
                    <li key={key} className={`sbs-chip ${available ? 'sbs-chip--on' : 'sbs-chip--off'}`}>
                      <span>{FACILITY_CHIP_LABELS[key]}</span>
                      <span className="sbs-chip__state">{available ? 'Tersedia' : 'Tidak tersedia'}</span>
                    </li>
                  )
                })}
              </ul>
            </article>
          ))}
        </div>
      </section>
    )
  }

  // ---- Netra renderer: verbal list with TTS + always-visible text twin ----
  return (
    <section className="sbs-page" aria-labelledby="sbs-heading">
      <div className="sbs-page__heading">
        <p className="eyebrow">FASILITAS HALTE</p>
        <h2 id="sbs-heading">Fasilitas halte</h2>
        <p className="sbs-page__intro">Dengarkan atau baca fasilitas aksesibilitas di setiap halte.</p>
      </div>
      <div className="sbs-list">
        {stops.map((stop) => (
          <article className="sbs-stop-card" key={stop.id}>
            <h3 className="sbs-stop-card__name">{stop.name}</h3>
            <p className="sbs-announcement">{buildStopAnnouncement(stop)}</p>
            <button
              type="button"
              className="sbs-speak-button"
              onClick={() => void handleSpeak(stop)}
              disabled={!tts || speakingStopId === stop.id}
            >
              {speakingStopId === stop.id ? 'Membacakan…' : 'Bacakan'}
            </button>
          </article>
        ))}
      </div>
    </section>
  )
}
