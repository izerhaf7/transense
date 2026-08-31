/**
 * Netra camera scan: approach detection → TTS + vibration on top of CameraScan's
 * CV detections, plus periodic Google Cloud Vision OCR for the corridor number.
 *
 * The approach heuristic and announcement text live in `approach.ts` (pure and
 * unit-tested); this component only wires the pipeline: fold the frame's
 * detections into one tracked box via `chooseNextDetection`, detect growth via
 * `isApproaching`, then speak the announcement and vibrate with the journey
 * `vehicleApproaching` pattern. While a bus is present it posts the latest
 * camera frame to the backend OCR proxy (`POST /api/vision/ocr`) every ~2.5 s
 * to learn the corridor; a Vision outage keeps the last reading (or null) and
 * never blocks the approach cue.
 *
 * Demo honesty: the simulated path (CameraScan's "Simulasikan armada
 * terdeteksi" and the in-app demo toggle) drives the SAME approach + TTS
 * pipeline but skips OCR — there is no real frame to read, so no OCR text is
 * ever fabricated. The demo mode is labelled clearly in the UI.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import CameraScan from './CameraScan'
import { buildAnnouncement, chooseNextDetection, isApproaching } from './approach'
import type { Detection } from './approach'
import { VIBRATION_PATTERNS } from './journey'
import type { PlanPoint } from './plannerStorage'
import type { TtsProvider } from './tts'

const OCR_INTERVAL_MS = 2500

interface NetraScanProps {
  apiBaseUrl: string
  tts?: TtsProvider
  /**
   * Destination chosen in the Antar Aku planner. Station-navigation context
   * for the Gemini peron flow (spec `transense-multi-profil-navigasi.md`);
   * optional so the scanner still works standalone. Not yet consumed by the
   * detection pipeline — T6 wires it into the navigation prompt.
   */
  destinationStop?: PlanPoint | null
}

/** `ImageData` frame → base64 JPEG data-URL payload for the OCR proxy. */
function imageDataToBase64(frame: ImageData, quality = 0.7): string {
  const canvas = document.createElement('canvas')
  canvas.width = frame.width
  canvas.height = frame.height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return ''
  }
  ctx.putImageData(frame, 0, 0)
  return canvas.toDataURL('image/jpeg', quality).split(',')[1] ?? ''
}

/**
 * Deterministic demo growth: re-position the box around `next`'s center but at
 * 130% of `previous`'s size, so each simulated frame is the same bus closer and
 * the approach heuristic fires without a real camera frame.
 */
function growBoxAroundCenter(previous: Detection, next: Detection, ratio = 1.3): Detection {
  const centerX = next.box.x + next.box.width / 2
  const centerY = next.box.y + next.box.height / 2
  const width = previous.box.width * ratio
  const height = previous.box.height * ratio
  return {
    ...next,
    box: { x: centerX - width / 2, y: centerY - height / 2, width, height },
  }
}

function NetraScan({ apiBaseUrl, tts, destinationStop }: NetraScanProps) {
  const [status, setStatus] = useState('Mencari bus…')
  const [approaching, setApproaching] = useState(false)
  const [demoMode, setDemoMode] = useState(false)
  const [navActive, setNavActive] = useState(false)
  const [navInstruction, setNavInstruction] = useState<string>('')
  const [navDirection, setNavDirection] = useState<string>('')
  const [navLoading, setNavLoading] = useState(false)
  const trackedDetectionRef = useRef<Detection | null>(null)
  const hasDetectionRef = useRef(false)
  const lastFrameRef = useRef<ImageData | null>(null)
  const lastOcrTextRef = useRef<string | null>(null)

  const handleFrame = useCallback((frame: ImageData) => {
    lastFrameRef.current = frame
  }, [])

  const handleDetection = useCallback((detections: Detection[]) => {
    if (detections.length === 0) {
      hasDetectionRef.current = false
      setApproaching(false)
      if (status === 'Bus mendekat!') {
        setStatus('Mencari bus…')
      }
      return
    }
    let tracked = trackedDetectionRef.current ?? detections[0]
    for (const detection of detections) {
      tracked = chooseNextDetection(tracked, detection)
    }
    const previous = trackedDetectionRef.current
    if (demoMode && previous) {
      // CameraScan's synthetic box is constant; grow it deterministically so
      // the demo demonstrates the SAME approach + TTS pipeline (no real frame).
      tracked = growBoxAroundCenter(previous, tracked)
    }
    trackedDetectionRef.current = tracked
    hasDetectionRef.current = true
    if (previous && isApproaching(previous, tracked)) {
      tts?.speak(buildAnnouncement(tracked, lastOcrTextRef.current))
      if ('vibrate' in navigator && typeof navigator.vibrate === 'function') {
        navigator.vibrate(VIBRATION_PATTERNS.vehicleApproaching)
      }
      setApproaching(true)
      setStatus('Bus mendekat!')
    }
  }, [demoMode, status, tts])

  // Periodic OCR: while a bus is detected, read the latest camera frame every
  // ~2.5 s. Failures keep the last reading (or null) — OCR never blocks detection.
  useEffect(() => {
    if (demoMode) {
      return
    }
    const interval = window.setInterval(() => {
      if (!hasDetectionRef.current) {
        return
      }
      const frame = lastFrameRef.current
      if (!frame) {
        return
      }
      const imageBase64 = imageDataToBase64(frame)
      if (!imageBase64) {
        return
      }
      fetch(`${apiBaseUrl}/api/vision/ocr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: imageBase64 }),
      })
        .then(async (response) => {
          if (!response.ok) {
            return
          }
          const data = (await response.json()) as { text?: string }
          lastOcrTextRef.current = data.text || null
        })
        .catch(() => {
          // keep the last reading; a Vision outage never blocks the approach cue
        })
    }, OCR_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [apiBaseUrl, demoMode])

  // Station navigation (Gemini multimodal): capture the latest camera frame,
  // POST /api/vision/nav, then TTS + haptic + text twin. Never fabricates —
  // only renders what the API returns; unavailable falls back to its text.
  const handleNavigation = useCallback(async () => {
    setNavLoading(true)
    setNavActive(true)
    setNavDirection('')
    try {
      const frame = lastFrameRef.current
      if (!frame) {
        setNavInstruction('Kamera belum siap. Coba lagi.')
        return
      }
      const base64 = imageDataToBase64(frame, 0.7)
      if (!base64) {
        setNavInstruction('Kamera belum siap. Coba lagi.')
        return
      }
      const stationContext = destinationStop?.name ?? 'dalam area stasiun kereta'
      const destinationText = destinationStop?.name ? `${destinationStop.name} peron` : 'peron'
      const response = await fetch(`${apiBaseUrl}/api/vision/nav`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_base64: base64,
          station_context: stationContext,
          destination: destinationText,
        }),
      })
      if (!response.ok) {
        setNavInstruction('Navigasi gagal. Coba lagi.')
        return
      }
      const data = (await response.json()) as {
        source?: string
        instruction?: { arah?: string; instruksi?: string }
        fallback_text?: string
      }
      if (data.source === 'gemini' && data.instruction && typeof data.instruction.instruksi === 'string') {
        const instruction = data.instruction.instruksi
        const direction = typeof data.instruction.arah === 'string' ? data.instruction.arah : ''
        setNavInstruction(instruction)
        setNavDirection(direction)
        tts?.speak(instruction)
        if ('vibrate' in navigator && typeof navigator.vibrate === 'function') {
          const lowered = direction.toLowerCase()
          let pattern: number[] = [50]
          if (lowered === 'kiri') {
            pattern = [100]
          } else if (lowered === 'kanan') {
            pattern = [100, 50, 100]
          } else if (lowered === 'depan') {
            pattern = [200]
          } else if (lowered === 'berhenti') {
            pattern = [500]
          }
          navigator.vibrate(pattern)
        }
        return
      }
      if (data.source === 'unavailable' && typeof data.fallback_text === 'string') {
        setNavInstruction(data.fallback_text)
        tts?.speak(data.fallback_text)
        return
      }
      setNavInstruction('Navigasi gagal. Coba lagi.')
    } catch {
      setNavInstruction('Navigasi gagal. Coba lagi.')
    } finally {
      setNavLoading(false)
    }
  }, [apiBaseUrl, destinationStop, tts])

  return (
    <section className="netra-scan" style={{ padding: 'var(--brand-screen-padding)' }}>
      <h2 style={{ fontSize: 'var(--brand-font-size-xl)', marginBottom: 'var(--brand-space-sm)' }}>Pemindai Netra</h2>

      <CameraScan apiBaseUrl={apiBaseUrl} onDetection={handleDetection} onFrame={handleFrame} simulated={demoMode} />

      <p
        className="netra-scan__status"
        role="status"
        aria-live="polite"
        style={{
          minHeight: 'calc(var(--brand-font-size-lg) * var(--brand-line-height))',
          fontSize: 'var(--brand-font-size-lg)',
          fontWeight: 'var(--brand-font-weight-strong)',
          margin: 'var(--brand-space-base) 0',
          color: approaching ? 'var(--brand-color-success-foreground)' : 'var(--brand-color-text)',
        }}
      >
        {status}
      </p>

      <section
        className="netra-scan__nav"
        aria-label="Navigasi stasiun"
        style={{ margin: '0 0 var(--brand-space-base)' }}
      >
        <button
          type="button"
          className="primary-button netra-scan__nav-button"
          onClick={() => {
            void handleNavigation()
          }}
          disabled={navLoading}
          style={{
            minHeight: '56px',
            width: '100%',
            padding: '0 var(--brand-space-lg)',
            borderRadius: 'var(--brand-radius-pill)',
            fontSize: 'var(--brand-font-size-lg)',
            fontWeight: 'var(--brand-font-weight-strong)',
          }}
        >
          {navLoading ? 'Menganalisis...' : 'Navigasi ke peron'}
        </button>

        {destinationStop ? (
          <p
            className="netra-scan__nav-context"
            style={{
              fontSize: 'var(--brand-font-size-base)',
              color: 'var(--brand-color-text)',
              margin: 'var(--brand-space-sm) 0 0',
            }}
          >
            Menuju: {destinationStop.name}
          </p>
        ) : null}

        {navActive ? (
          <div
            className="netra-scan__nav-result"
            style={{ marginTop: 'var(--brand-space-base)' }}
          >
            {navDirection ? (
              <p
                className="netra-scan__nav-direction"
                style={{
                  fontSize: 'var(--brand-font-size-xl)',
                  fontWeight: 'var(--brand-font-weight-strong)',
                  color: 'var(--brand-color-accent-foreground, var(--brand-color-text))',
                  margin: '0 0 var(--brand-space-sm)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                {(() => {
                  const lowered = navDirection.toLowerCase()
                  if (lowered === 'kiri') return 'KE KIRI'
                  if (lowered === 'kanan') return 'KE KAN'
                  if (lowered === 'depan') return 'KE DEPAN'
                  if (lowered === 'berhenti') return 'BERHENTI'
                  return navDirection.toUpperCase()
                })()}
              </p>
            ) : null}
            <p
              role="status"
              aria-live="polite"
              className="netra-scan__nav-instruction"
              style={{
                fontSize: 'var(--brand-font-size-lg)',
                fontWeight: 'var(--brand-font-weight-strong)',
                lineHeight: 'var(--brand-line-height)',
                color: 'var(--brand-color-text)',
                margin: 0,
              }}
            >
              {navInstruction}
            </p>
          </div>
        ) : null}
      </section>

      {demoMode ? (
        <p
          className="netra-scan__demo-label"
          style={{
            fontSize: 'var(--brand-font-size-base)',
            fontWeight: 'var(--brand-font-weight-strong)',
            color: 'var(--brand-color-warning-foreground)',
            margin: '0 0 var(--brand-space-base)',
          }}
        >
          MODE DEMO TERSIMULASI — deteksi armada disimulasikan; OCR dinonaktifkan karena tidak ada frame asli.
        </p>
      ) : null}

      <button
        type="button"
        className="primary-button netra-scan__demo-toggle"
        onClick={() => setDemoMode((current) => !current)}
        style={{
          minHeight: 'var(--brand-control-height-lg)',
          padding: '0 var(--brand-space-lg)',
          borderRadius: 'var(--brand-radius-pill)',
        }}
      >
        {demoMode ? 'Kembali ke kamera asli' : 'Aktifkan mode demo tersimulasi'}
      </button>
    </section>
  )
}

export default NetraScan
