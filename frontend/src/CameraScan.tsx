/**
 * Netra camera scan: detects an approaching bus through the phone camera using
 * the MediaPipe Object Detector worker (`mediapipe.worker.ts`). The heavy,
 * synchronous `detectForVideo` call lives in the Web Worker so the UI stays
 * responsive; this component only grabs a low-rate frame (~every 2.5 s) from
 * the live `<video>` preview and posts it to the worker.
 *
 * Audio-blind by design: a large high-contrast status line and a drawn
 * bounding box are the only feedback. `Simulasikan armada terdeteksi` injects a
 * synthetic detection through the worker pipeline so the demo is deterministic
 * without a camera, HTTPS origin, or network — and it stays usable when camera
 * permission is denied (readable Indonesian error, never a crash).
 */

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { CameraWorkerRequest, CameraWorkerResponse, Detection } from './mediapipe.worker'

const DETECT_INTERVAL_MS = 2500

type CameraStatus = 'starting' | 'scanning' | 'detected' | 'camera-error' | 'model-error'

interface CameraScanProps {
  apiBaseUrl: string
  onDetection?: (detections: Detection[]) => void
  /** Receives the raw frame each time a detect frame is captured — lets the Netra pipeline OCR it. */
  onFrame?: (frame: ImageData) => void
  /** When true, a synthetic detection fires automatically once the worker is ready. */
  simulated?: boolean
}

/** Readable Indonesian fallback for the two common camera failures. */
function readableCameraError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      return 'Kamera tidak tersedia — aktifkan izin kamera'
    }
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      return 'Kamera tidak ditemukan di perangkat ini'
    }
    if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
      return 'Kamera sedang dipakai aplikasi lain'
    }
  }
  return 'Kamera tidak tersedia — aktifkan izin kamera'
}

function CameraScan({ apiBaseUrl, onDetection, onFrame, simulated }: CameraScanProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const lastDetectAtRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const disposedRef = useRef(false)
  const simulatedRef = useRef(simulated)
  simulatedRef.current = simulated
  const onDetectionRef = useRef(onDetection)
  onDetectionRef.current = onDetection
  const onFrameRef = useRef(onFrame)
  onFrameRef.current = onFrame

  const [status, setStatus] = useState<CameraStatus>('starting')
  const [statusMessage, setStatusMessage] = useState('')
  const [detectionBox, setDetectionBox] = useState<Detection | null>(null)

  const postSimulatedDetection = () => {
    const worker = workerRef.current
    if (!worker) {
      return
    }
    const video = videoRef.current
    const width = video?.videoWidth ?? 640
    const height = video?.videoHeight ?? 480
    const message: CameraWorkerRequest = {
      type: 'detect',
      timestamp: video?.currentTime ? Math.round(video.currentTime * 1000) : Math.round(performance.now()),
      simulatedDetections: [
        {
          box: {
            x: Math.round(width * 0.15),
            y: Math.round(height * 0.25),
            width: Math.round(width * 0.7),
            height: Math.round(height * 0.5),
          },
          score: 0.95,
        },
      ],
    }
    worker.postMessage(message)
  }

  useEffect(() => {
    disposedRef.current = false
    lastDetectAtRef.current = 0

    const worker = new Worker(new URL('./mediapipe.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker

    const maybeDetect = (video: HTMLVideoElement) => {
      const now = performance.now()
      if (now - lastDetectAtRef.current < DETECT_INTERVAL_MS) {
        return
      }
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        return
      }
      if (!frameCanvasRef.current) {
        frameCanvasRef.current = document.createElement('canvas')
      }
      const canvas = frameCanvasRef.current
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      if (canvas.width === 0 || canvas.height === 0) {
        return
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        return
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      onFrameRef.current?.(imageData)
      lastDetectAtRef.current = now
      const message: CameraWorkerRequest = {
        type: 'detect',
        timestamp: Math.round(video.currentTime * 1000),
        imageData,
      }
      worker.postMessage(message)
    }

    const startFrameLoop = () => {
      const video = videoRef.current
      if (!video || disposedRef.current) {
        return
      }
      if (typeof video.requestVideoFrameCallback === 'function') {
        const step = () => {
          if (disposedRef.current) {
            return
          }
          maybeDetect(video)
          video.requestVideoFrameCallback(step)
        }
        video.requestVideoFrameCallback(step)
      } else {
        const rafStep = () => {
          if (disposedRef.current) {
            return
          }
          maybeDetect(video)
          rafRef.current = requestAnimationFrame(rafStep)
        }
        rafRef.current = requestAnimationFrame(rafStep)
      }
    }

    worker.onmessage = (event: MessageEvent<CameraWorkerResponse>) => {
      if (disposedRef.current) {
        return
      }
      const message = event.data
      if (message.type === 'ready') {
        setStatus('scanning')
        setStatusMessage('')
        startFrameLoop()
        if (simulatedRef.current) {
          postSimulatedDetection()
        }
      } else if (message.type === 'detection') {
        setDetectionBox(message.detections[0] ?? null)
        setStatus(message.detections.length > 0 ? 'detected' : 'scanning')
        onDetectionRef.current?.(message.detections)
      } else if (message.type === 'error') {
        setStatus('model-error')
        setStatusMessage(message.message)
      }
    }

    const initMessage: CameraWorkerRequest = {
      type: 'init',
      // Wired now so task 4.3 can ask this worker to run periodic OCR via the
      // backend proxy without changing the component/worker protocol.
      ocrEndpoint: `${apiBaseUrl}/api/vision/ocr`,
    }
    worker.postMessage(initMessage)

    const startCamera = async () => {
      const video = videoRef.current
      if (!video) {
        return
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('camera-error')
        setStatusMessage('Kamera tidak tersedia — aktifkan izin kamera')
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        })
        if (disposedRef.current) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        video.srcObject = stream
        video.playsInline = true
        video.autoplay = true
        video.muted = true
        await video.play()
      } catch (error) {
        if (disposedRef.current) {
          return
        }
        setStatus('camera-error')
        setStatusMessage(readableCameraError(error))
      }
    }
    void startCamera()

    return () => {
      disposedRef.current = true
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [apiBaseUrl])

  let boxStyle: CSSProperties | undefined
  if (detectionBox) {
    const video = videoRef.current
    const scaleX = video && video.videoWidth > 0 ? video.clientWidth / video.videoWidth : 1
    const scaleY = video && video.videoHeight > 0 ? video.clientHeight / video.videoHeight : 1
    boxStyle = {
      left: `${detectionBox.box.x * scaleX}px`,
      top: `${detectionBox.box.y * scaleY}px`,
      width: `${detectionBox.box.width * scaleX}px`,
      height: `${detectionBox.box.height * scaleY}px`,
    }
  }

  const statusText =
    status === 'starting'
      ? 'Menyiapkan kamera…'
      : status === 'scanning'
        ? 'Mencari bus…'
        : status === 'detected'
          ? 'Bus terdeteksi!'
          : status === 'camera-error'
            ? statusMessage || 'Kamera tidak tersedia — aktifkan izin kamera'
            : `Model deteksi gagal dimuat: ${statusMessage}`

  return (
    <section className="camera-scan" style={{ padding: 'var(--brand-screen-padding)' }}>
      <h2 style={{ fontSize: 'var(--brand-font-size-xl)', marginBottom: 'var(--brand-space-sm)' }}>Deteksi Armada</h2>

      <div
        className="camera-scan__viewport"
        style={{
          position: 'relative',
          overflow: 'hidden',
          borderRadius: 'var(--brand-radius-xl)',
          background: '#000000',
          boxShadow: 'var(--brand-shadow-card)',
        }}
      >
        <video
          ref={videoRef}
          className="camera-scan__video"
          playsInline
          autoPlay
          muted
          aria-label="Pratinjau kamera untuk mendeteksi bus"
          style={{ display: 'block', width: '100%', height: 'auto', minHeight: '220px' }}
        />
        {detectionBox && boxStyle ? (
          <div
            className="camera-scan__box"
            aria-hidden="true"
            style={{
              position: 'absolute',
              border: 'var(--brand-border-width-strong) solid var(--brand-color-accent)',
              borderRadius: 'var(--brand-radius-sm)',
              boxShadow: '0 0 0 2px var(--brand-color-background)',
              pointerEvents: 'none',
              ...boxStyle,
            }}
          />
        ) : null}
      </div>

      <p
        className="camera-scan__status"
        role="status"
        aria-live="polite"
        style={{
          minHeight: 'calc(var(--brand-font-size-lg) * var(--brand-line-height))',
          fontSize: 'var(--brand-font-size-lg)',
          fontWeight: 'var(--brand-font-weight-strong)',
          margin: 'var(--brand-space-base) 0',
          color: status === 'detected' ? 'var(--brand-color-success-foreground)' : 'var(--brand-color-text)',
        }}
      >
        {statusText}
      </p>

      <button
        type="button"
        className="camera-scan__simulate"
        onClick={postSimulatedDetection}
        style={{
          minHeight: 'var(--brand-control-height-lg)',
          padding: '0 var(--brand-space-lg)',
          borderRadius: 'var(--brand-radius-pill)',
          border: 'var(--brand-border-width) solid var(--brand-color-accent-border)',
          background: 'var(--brand-color-accent)',
          color: 'var(--brand-color-text-on-accent)',
          fontSize: 'var(--brand-font-size-base)',
          fontWeight: 'var(--brand-font-weight-strong)',
        }}
      >
        Simulasikan armada terdeteksi
      </button>
    </section>
  )
}

export default CameraScan
