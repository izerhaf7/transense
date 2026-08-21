// Home content-sheet arrivals panel (GPS + manual stop search).

import { useEffect, useState } from 'react'

import { apiBaseUrl } from '../api'
import { SearchIcon } from '../icons'

interface Arrival {
  bus_id: string
  route_code: string
  headsign: string
  eta_minutes: number
  distance_km: number
}

interface ArrivalsStop {
  id: string
  name: string
  lat: number
  lng: number
  type?: string
  platform?: string
}

type GpsStatus = 'idle' | 'locating' | 'located' | 'denied'

export function ArrivalsSheet() {
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>('idle')
  const [currentStop, setCurrentStop] = useState<ArrivalsStop | null>(null)
  const [arrivals, setArrivals] = useState<Arrival[]>([])
  const [detail, setDetail] = useState('Mencari halte terdekat…')
  const [manualQuery, setManualQuery] = useState('')
  const [suggestions, setSuggestions] = useState<ArrivalsStop[]>([])
  const [showManual, setShowManual] = useState(false)

  const fetchArrivals = async (params: string) => {
    try {
      const res = await fetch(`${apiBaseUrl}/api/arrivals?${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { arrivals: Arrival[]; stop: ArrivalsStop | null }
      if (data.stop) {
        setCurrentStop(data.stop)
        setDetail(`Halte ${data.stop.name}`)
      }
      setArrivals(data.arrivals ?? [])
      if ((data.arrivals ?? []).length === 0) {
        setDetail(data.stop ? `Tidak ada bus menuju ${data.stop.name} saat ini` : 'Tidak ada bus ditemukan')
      }
    } catch (error) {
      setDetail('Gagal mengambil data kedatangan.')
      console.warn('Arrivals fetch failed.', error)
    }
  }

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setGpsStatus('denied')
      setDetail('GPS tidak tersedia di browser ini. Ketik nama halte untuk melanjutkan.')
      setShowManual(true)
      return
    }
    setGpsStatus('locating')
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGpsStatus('located')
        void fetchArrivals(`lat=${position.coords.latitude}&lng=${position.coords.longitude}`)
      },
      () => {
        setGpsStatus('denied')
        setDetail('GPS tidak aktif atau ditolak. Ketik nama halte tempatmu berada.')
        setShowManual(true)
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    )
  }, [])

  const handleSearch = async (query: string) => {
    setManualQuery(query)
    if (query.trim().length < 2) {
      setSuggestions([])
      return
    }
    try {
      const res = await fetch(`${apiBaseUrl}/api/gtfs/stops/search?q=${encodeURIComponent(query.trim())}`)
      if (!res.ok) return
      const data = await res.json() as { stops: ArrivalsStop[] }
      setSuggestions(data.stops ?? [])
    } catch {
      setSuggestions([])
    }
  }

  const pickStop = (stop: ArrivalsStop) => {
    setManualQuery(stop.name)
    setSuggestions([])
    void fetchArrivals(`stop_id=${encodeURIComponent(stop.id)}`)
  }

  return (
    <section className="arrivals-sheet" aria-labelledby="arrivals-heading">
      <div className="arrivals-sheet__header">
        <div>
          <p className="eyebrow">BUS MENUJU HALTEMU</p>
          <h3 id="arrivals-heading">{currentStop ? currentStop.name : 'Halte terdekat'}</h3>
        </div>
        <span className={`state-badge state-badge--${gpsStatus === 'located' ? 'safe' : gpsStatus === 'locating' ? 'warning' : 'placeholder'}`}>
          {gpsStatus === 'located' ? 'GPS AKTIF' : gpsStatus === 'locating' ? 'MENCARI GPS' : 'GPS MATI'}
        </span>
      </div>

      {gpsStatus === 'denied' || showManual ? (
        <div className="arrivals-sheet__manual">
          <p className="arrivals-sheet__detail" role="status">{detail}</p>
          <div className="search-form arrivals-sheet__search">
            <span className="search-form__icon" aria-hidden="true"><SearchIcon size={20} /></span>
            <input
              value={manualQuery}
              onChange={(event) => { void handleSearch(event.target.value) }}
              placeholder="Ketik nama halte, mis. Petamburan"
            />
          </div>
          {suggestions.length ? (
            <div className="arrivals-sheet__suggestions">
              {suggestions.map((stop) => (
                <button className="arrivals-sheet__suggestion" type="button" key={stop.id} onClick={() => pickStop(stop)}>
                  <span className="arrivals-sheet__suggestion-name">{stop.name}</span>
                  <span className="arrivals-sheet__suggestion-type">{stop.type ?? 'Halte'}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="arrivals-sheet__detail" role="status">{detail}</p>
      )}

      <div className="arrivals-list" aria-live="polite">
        {arrivals.length ? arrivals.map((arrival) => (
          <article className="arrival-card" key={`${arrival.bus_id}-${arrival.eta_minutes}`}>
            <span className="arrival-card__route">{arrival.route_code}</span>
            <div className="arrival-card__body">
              <strong>{arrival.headsign}</strong>
              <span>{arrival.distance_km} km · {arrival.bus_id}</span>
            </div>
            <span className="arrival-card__eta">{arrival.eta_minutes}′</span>
          </article>
        )) : (
          <div className="empty-state"><SearchIcon className="empty-state__mark" size={24} /><h3>Belum ada bus</h3><p>{gpsStatus === 'locating' ? 'Sedang mencari halte terdekat…' : 'Cari halte lain atau tunggu update berikutnya.'}</p></div>
        )}
      </div>
    </section>
  )
}
