import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowBackIcon, LocateIcon, SearchIcon, StarIcon } from './icons'
import type { PlanPoint, SavedStop, SearchHistoryEntry } from './plannerStorage'
import { pointFromSavedStop, savedStopId } from './plannerStorage'
import type { ProfileType } from './profile'
import type { TtsProvider } from './tts'

/**
 * Full-page point picker for the trip planner (Dari / Ke). One input on top
 * searches halte; below, when idle, "Halte favorit" and "Terakhir dicari"
 * lists let the user pick a previously used point. Every halte row carries a
 * star toggle on its right edge so favorite management happens in place.
 */
const MAX_RECENT = 8

interface SearchResult {
  point: PlanPoint
  typeLabel?: string
}

interface StopPickerPageProps {
  apiBaseUrl: string
  kind: 'origin' | 'destination'
  savedStops: SavedStop[]
  history: SearchHistoryEntry[]
  profile?: ProfileType
  tts?: TtsProvider
  onPick: (point: PlanPoint, meta?: { viaLocation?: boolean }) => void
  onToggleFavorite: (point: PlanPoint) => void
  onBack: () => void
}

function favoriteIdOf(point: PlanPoint): string {
  return savedStopId(point)
}

export default function StopPickerPage({
  apiBaseUrl,
  kind,
  savedStops,
  history,
  profile = 'tuli',
  tts,
  onPick,
  onToggleFavorite,
  onBack,
}: StopPickerPageProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [locating, setLocating] = useState(false)
  const [locateError, setLocateError] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const trimmed = query.trim()
  const searchingActive = trimmed.length >= 2

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!searchingActive) {
      setResults([])
      setSearching(false)
      return
    }
    const controller = new AbortController()
    setSearching(true)
    fetch(`${apiBaseUrl}/api/gtfs/stops/search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return
        const data = await response.json() as { stops: { id: string; name: string; lat: number; lng: number; type?: string }[] }
        if (controller.signal.aborted) return
        const next: SearchResult[] = (data.stops ?? []).map((stop) => ({
          point: { stop_id: stop.id, name: stop.name, lat: stop.lat, lng: stop.lng },
          typeLabel: stop.type,
        }))
        setResults(next)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) console.warn('Stop search failed.', error)
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false)
      })
    return () => controller.abort()
  }, [searchingActive, trimmed, apiBaseUrl])

  const favoriteIds = useMemo(() => new Set(savedStops.map((stop) => stop.id)), [savedStops])

  const isFavorite = (point: PlanPoint) => favoriteIds.has(favoriteIdOf(point))

  const recentPoints = useMemo(() => {
    const seen = new Set<string>()
    const points: PlanPoint[] = []
    // History is stored most-recent-first; walk it and dedupe by point id.
    for (const entry of history) {
      for (const point of [entry.origin, entry.destination]) {
        const id = favoriteIdOf(point)
        if (seen.has(id)) continue
        seen.add(id)
        points.push(point)
        if (points.length >= MAX_RECENT) return points
      }
    }
    return points
  }, [history])

  const pick = (point: PlanPoint) => {
    if (profile === 'netra') tts?.speak(`${kind === 'origin' ? 'Asal' : 'Tujuan'}: ${point.name}`)
    onPick(point)
  }

  const pickNearest = (position: GeolocationPosition) => {
    fetch(`${apiBaseUrl}/api/gtfs/stops/nearby?lat=${position.coords.latitude}&lng=${position.coords.longitude}&limit=1`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json() as { stops: { id: string; name: string; lat: number; lng: number }[] }
        const nearest = (data.stops ?? [])[0]
        if (!nearest) {
          setLocateError('Tidak ada halte dekat lokasimu.')
          return
        }
        setLocateError('')
        if (profile === 'netra') tts?.speak(`Pakai lokasi saya: ${nearest.name}`)
        onPick({ stop_id: nearest.id, name: nearest.name, lat: nearest.lat, lng: nearest.lng }, { viaLocation: true })
      })
      .catch((error: unknown) => {
        setLocateError('Tidak bisa mendapatkan lokasi.')
        console.warn('Nearby stops lookup failed.', error)
      })
      .finally(() => setLocating(false))
  }

  const locate = () => {
    if (!('geolocation' in navigator)) {
      setLocateError('Perangkat tidak mendukung lokasi.')
      return
    }
    setLocating(true)
    setLocateError('')
    navigator.geolocation.getCurrentPosition(
      pickNearest,
      (error) => {
        setLocateError(error.code === 1 ? 'Izin lokasi ditolak.' : 'Tidak bisa mendapatkan lokasi.')
        setLocating(false)
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    )
  }

  const heading = kind === 'origin' ? 'Pilih titik asal' : 'Pilih titik tujuan'
  const searchPlaceholder = kind === 'origin' ? 'Cari halte asal…' : 'Cari halte tujuan…'

  const sectionHeading = (text: string) => (
    <p className="eyebrow">{text}</p>
  )

  return (
    <main className="page-content inner-page planner-page">
      <div className="page-intro">
        <button type="button" className="schedule-detail__back" onClick={onBack}><ArrowBackIcon size={18} /> Kembali</button>
        <p className="eyebrow">ANTAR AKU · {kind === 'origin' ? 'TITIK ASAL' : 'TITIK TUJUAN'}</p>
        <h2>{heading}</h2>
      </div>

      <div className="planner-form">
        <label className="planner-field">
          <span className="planner-field__label">{kind === 'origin' ? 'Dari' : 'Ke'}</span>
          <div className="stop-picker-search">
            <span className="search-form__icon" aria-hidden="true"><SearchIcon size={20} /></span>
            <input
              ref={inputRef}
              className="stop-picker-search__input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              autoComplete="off"
              aria-label={`Cari halte ${kind === 'origin' ? 'asal' : 'tujuan'}`}
            />
          </div>
        </label>

        {kind === 'origin' ? (
          <>
            <button type="button" className={`planner-locate-btn${profile === 'netra' ? ' planner-btn--netra' : ''}`} onClick={locate} disabled={locating}>
              <LocateIcon size={20} />
              {locating ? 'Mencari…' : 'Pakai lokasi saya'}
            </button>
            {locateError ? (
              <p className="planner-locate-error" role="status">{locateError}</p>
            ) : null}
          </>
        ) : null}

        {searchingActive ? (
          <section className="stop-picker-section" aria-label="Hasil pencarian halte">
            {sectionHeading('HASIL PENCARIAN')}
            {searching && results.length === 0 ? (
              <p className="stop-picker-empty" role="status">Mencari halte…</p>
            ) : results.length === 0 ? (
              <p className="stop-picker-empty">Tidak ada halte yang cocok.</p>
            ) : (
              <ul className="stop-picker-list">
                {results.map(({ point, typeLabel }) => (
                  <li key={favoriteIdOf(point)} className="stop-picker-item">
                    <button type="button" className="stop-picker-item__pick" onClick={() => pick(point)}>
                      <span className="stop-picker-item__name">{point.name}</span>
                      {typeLabel ? <span className="stop-picker-item__sub">{typeLabel}</span> : null}
                    </button>
                    <button
                      type="button"
                      className={`stop-picker-item__star${isFavorite(point) ? ' stop-picker-item__star--active' : ''}`}
                      aria-label={isFavorite(point) ? `Hapus ${point.name} dari favorit` : `Simpan ${point.name} sebagai favorit`}
                      aria-pressed={isFavorite(point)}
                      onClick={() => onToggleFavorite(point)}
                    >
                      <StarIcon size={20} filled={isFavorite(point)} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <>
            <section className="stop-picker-section" aria-label="Halte favorit">
              {sectionHeading('HALTE FAVORIT')}
              {savedStops.length === 0 ? (
                <p className="stop-picker-empty">Belum ada favorit. Cari halte lalu tekan bintang untuk menyimpannya.</p>
              ) : (
                <ul className="stop-picker-list">
                  {savedStops.map((stop) => {
                    const point = pointFromSavedStop(stop)
                    return (
                      <li key={stop.id} className="stop-picker-item">
                        <button type="button" className="stop-picker-item__pick" onClick={() => pick(point)}>
                          <span className="stop-picker-item__name">{stop.name}</span>
                          {stop.stopName !== stop.name ? <span className="stop-picker-item__sub">{stop.stopName}</span> : null}
                        </button>
                        <button
                          type="button"
                          className="stop-picker-item__star stop-picker-item__star--active"
                          aria-label={`Hapus ${stop.name} dari favorit`}
                          aria-pressed
                          onClick={() => onToggleFavorite(point)}
                        >
                          <StarIcon size={20} filled />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            <section className="stop-picker-section" aria-label="Terakhir dicari">
              {sectionHeading('TERAKHIR DICARI')}
              {recentPoints.length === 0 ? (
                <p className="stop-picker-empty">Belum ada riwayat. Rute yang berhasil dicari akan muncul di sini.</p>
              ) : (
                <ul className="stop-picker-list">
                  {recentPoints.map((point) => (
                    <li key={favoriteIdOf(point)} className="stop-picker-item">
                      <button type="button" className="stop-picker-item__pick" onClick={() => pick(point)}>
                        <span className="stop-picker-item__name">{point.name}</span>
                      </button>
                      <button
                        type="button"
                        className={`stop-picker-item__star${isFavorite(point) ? ' stop-picker-item__star--active' : ''}`}
                        aria-label={isFavorite(point) ? `Hapus ${point.name} dari favorit` : `Simpan ${point.name} sebagai favorit`}
                        aria-pressed={isFavorite(point)}
                        onClick={() => onToggleFavorite(point)}
                      >
                        <StarIcon size={20} filled={isFavorite(point)} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  )
}
