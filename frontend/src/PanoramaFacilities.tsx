/**
 * PanoramaFacilities: a dependency-free, CSS-scroll 360° panorama viewer with
 * accessibility facility annotations for the Side by Side daksa renderer.
 *
 * A wide cylindrical panorama image sits inside a horizontally scrollable
 * track; facility chips are absolutely positioned children of the track
 * (`left = (yaw/360) * 100%`), so they glide naturally with the image as the
 * user scrolls. Navigation is button-driven (`scrollBy` in 45° steps) so no
 * drag gesture is required — an explicit motor-accessibility choice. Native
 * touch inertia, keyboard arrow keys, and scroll-snap come for free.
 *
 * The current viewing direction (`viewYaw`) is derived from `scrollLeft` and
 * announced through a polite `aria-live` region; chips within ±45° of it are
 * highlighted as active. If the image fails to load, the viewer degrades to a
 * labelled fallback instead of rendering a broken image.
 */

import { useEffect, useRef, useState } from 'react'
import type { PanoramaChip } from './panoramaConfig'

interface PanoramaFacilitiesProps {
  src: string
  chips: PanoramaChip[]
  stopName: string
}

/** Full field of view of the visible window, in degrees. */
const FOV_DEGREES = 90
/** Navigation step per arrow press, in degrees. */
const STEP_DEGREES = 45

const FACILITY_DISPLAY_LABELS: Record<string, string> = {
  ramp: 'Ramp',
  lift: 'Lift',
  toilet_accessible: 'Toilet aksesibel',
  guiding_block: 'Guiding block',
  staffed: 'Staf',
  step_free_access: 'Step-free',
}

const DIRECTION_LABELS: Array<{ max: number; label: string }> = [
  { max: 45, label: 'utara' },
  { max: 135, label: 'timur' },
  { max: 225, label: 'selatan' },
  { max: 315, label: 'barat' },
  { max: 360, label: 'utara' },
]

function angularDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360
  return diff > 180 ? 360 - diff : diff
}

function directionLabel(yaw: number): string {
  const normalized = ((yaw % 360) + 360) % 360
  const entry = DIRECTION_LABELS.find((item) => normalized < item.max)
  return entry ? entry.label : 'utara'
}

export default function PanoramaFacilities({ src, chips, stopName }: PanoramaFacilitiesProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [viewYaw, setViewYaw] = useState(0)
  const [imageFailed, setImageFailed] = useState(false)

  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const update = () => {
      const { scrollLeft, scrollWidth, clientWidth } = track
      if (scrollWidth <= 0) return
      const degPerPx = 360 / scrollWidth
      setViewYaw((scrollLeft + clientWidth / 2) * degPerPx)
    }
    update()
    track.addEventListener('scroll', update, { passive: true })
    return () => track.removeEventListener('scroll', update)
  }, [src])

  const handleNav = (direction: 1 | -1) => {
    const track = trackRef.current
    if (!track) return
    const pxPerDegree = track.scrollWidth / 360
    track.scrollBy({ left: direction * STEP_DEGREES * pxPerDegree, behavior: 'smooth' })
    navigator.vibrate?.(10)
  }

  if (imageFailed) {
    return (
      <div className="sbs-stop-card__visual" role="img" aria-label={`Pratinjau 360° ${stopName}`}>
        <span className="sbs-visual-label">Pratinjau 360° tidak tersedia</span>
      </div>
    )
  }

  const nearest = chips.reduce<PanoramaChip | null>(
    (best, chip) => (best === null || angularDistance(chip.yaw, viewYaw) < angularDistance(best.yaw, viewYaw) ? chip : best),
    null,
  )
  const nearestLabel = nearest ? (FACILITY_DISPLAY_LABELS[nearest.facility] ?? nearest.facility) : null
  const liveText = nearestLabel ? `Menghadap ke ${nearestLabel}` : `Menghadap ke ${directionLabel(viewYaw)}`

  return (
    <div className="pano-viewer" role="group" aria-label={`Pratinjau 360° ${stopName}`}>
      <div className="pano-track" ref={trackRef}>
        <img src={src} alt={`Panorama 360° ${stopName}`} onError={() => setImageFailed(true)} />
        {chips.map((chip) => {
          const isActive = angularDistance(chip.yaw, viewYaw) <= FOV_DEGREES / 2
          const label = FACILITY_DISPLAY_LABELS[chip.facility] ?? chip.facility
          return (
            <div
              key={chip.facility}
              className={`pano-chip${isActive ? ' pano-chip--active' : ''}`}
              style={{ left: `${(chip.yaw / 360) * 100}%` }}
            >
              {label}
            </div>
          )
        })}
      </div>
      <button
        type="button"
        className="pano-nav-btn pano-nav-btn--left"
        aria-label="Putar panorama ke kiri"
        onClick={() => handleNav(-1)}
      >
        ‹
      </button>
      <button
        type="button"
        className="pano-nav-btn pano-nav-btn--right"
        aria-label="Putar panorama ke kanan"
        onClick={() => handleNav(1)}
      >
        ›
      </button>
      <span className="pano-aria-live" aria-live="polite">
        {liveText}
      </span>
    </div>
  )
}
