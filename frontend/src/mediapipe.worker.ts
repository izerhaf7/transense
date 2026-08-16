/**
 * MediaPipe Object Detector worker for the Transense Netra camera scan.
 *
 * Runs `@mediapipe/tasks-vision` (pinned `^1.0.1`) OFF the main thread so the
 * synchronous `detectForVideo` never blocks the UI. The main thread posts
 * low-rate frames (every ~2-3 s); this worker normalizes them to `ImageData`
 * (via an `OffscreenCanvas` when the frame arrives as an `ImageBitmap`), runs
 * the COCO "bus" detector, and posts normalized boxes back.
 *
 * Worker protocol:
 *   in   { type: 'init', modelUrl?, wasmUrl? }
 *   in   { type: 'detect', timestamp, imageData?, simulatedDetections? }
 *   out  { type: 'ready' }
 *   out  { type: 'detection', detections: Detection[] }
 *   out  { type: 'error', message: string }
 *
 * `simulatedDetections` short-circuit MediaPipe entirely: the worker echoes the
 * synthetic boxes straight back so deterministic demos can inject a "bus"
 * without a camera, network, or model. This file is self-contained — it only
 * relies on `self` and the WASM package, never on app code or DOM globals.
 */

import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision'
import type { Detection as MediaPipeDetection, ObjectDetectorResult } from '@mediapipe/tasks-vision'

/** A bounding box in video-pixel coordinates. */
export interface DetectionBox {
  x: number
  y: number
  width: number
  height: number
}

/** A normalized detection: box in pixels plus a confidence score (0..1). */
export interface Detection {
  box: DetectionBox
  score: number
}

export interface CameraWorkerInitMessage {
  type: 'init'
  modelUrl?: string
  wasmUrl?: string
}

export interface CameraWorkerDetectMessage {
  type: 'detect'
  /** Monotonic video timestamp in ms (from `video.currentTime * 1000`). */
  timestamp: number
  imageData?: ImageBitmap | ImageData
  /** When present, skips MediaPipe and posts these boxes directly. */
  simulatedDetections?: Detection[]
}

export type CameraWorkerRequest = CameraWorkerInitMessage | CameraWorkerDetectMessage

export interface CameraWorkerReadyMessage {
  type: 'ready'
}

export interface CameraWorkerDetectionMessage {
  type: 'detection'
  detections: Detection[]
}

export interface CameraWorkerErrorMessage {
  type: 'error'
  message: string
}

export type CameraWorkerResponse = CameraWorkerReadyMessage | CameraWorkerDetectionMessage | CameraWorkerErrorMessage

// WASM is self-hosted at /wasm (copied from node_modules/@mediapipe/tasks-vision
// on build; Vite copies public/ into dist) so the detector never depends on a
// third-party CDN — a CDN load failure surfaces as "ModuleFactory not set".
// The COCO model stays on the Google-hosted storage URL.
const DEFAULT_WASM_URL = '/wasm'
const DEFAULT_MODEL_URL = 'https://storage.googleapis.com/mediapipe-tasks/object_detector/efficientdet_lite0_uint8.tflite'

const SCORE_THRESHOLD = 0.5
const MAX_RESULTS = 5

let detector: ObjectDetector | null = null

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `detectForVideo` accepts `ImageData` directly; an `ImageBitmap` needs a worker-side canvas. */
function toImageData(frame: ImageBitmap | ImageData): ImageData {
  if (frame instanceof ImageData) {
    return frame
  }
  const canvas = new OffscreenCanvas(frame.width, frame.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Tidak bisa membuat konteks kanvas untuk frame kamera.')
  }
  ctx.drawImage(frame, 0, 0)
  return ctx.getImageData(0, 0, frame.width, frame.height)
}

function normalizeDetection(detection: MediaPipeDetection): Detection | null {
  const box = detection.boundingBox
  if (!box) {
    return null
  }
  let bestScore = 0
  for (const category of detection.categories) {
    if (category.score > bestScore) {
      bestScore = category.score
    }
  }
  return {
    box: { x: box.originX, y: box.originY, width: box.width, height: box.height },
    score: bestScore,
  }
}

function normalizeResult(result: ObjectDetectorResult): Detection[] {
  const detections: Detection[] = []
  for (const detection of result.detections) {
    const normalized = normalizeDetection(detection)
    if (normalized) {
      detections.push(normalized)
    }
  }
  return detections
}

async function handleInit(message: CameraWorkerInitMessage): Promise<void> {
  try {
    const vision = await FilesetResolver.forVisionTasks(message.wasmUrl ?? DEFAULT_WASM_URL)
    detector = await ObjectDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: message.modelUrl ?? DEFAULT_MODEL_URL },
      scoreThreshold: SCORE_THRESHOLD,
      runningMode: 'VIDEO',
      maxResults: MAX_RESULTS,
      categoryAllowlist: ['bus'],
    })
    self.postMessage({ type: 'ready' } satisfies CameraWorkerReadyMessage)
  } catch (error: unknown) {
    self.postMessage({ type: 'error', message: describeError(error) } satisfies CameraWorkerErrorMessage)
  }
}

function handleDetect(message: CameraWorkerDetectMessage): void {
  // Deterministic demo path: synthetic detections bypass MediaPipe entirely.
  if (Array.isArray(message.simulatedDetections)) {
    self.postMessage({ type: 'detection', detections: message.simulatedDetections } satisfies CameraWorkerDetectionMessage)
    return
  }
  if (!detector) {
    self.postMessage({ type: 'error', message: 'Detektor belum siap.' } satisfies CameraWorkerErrorMessage)
    return
  }
  if (!message.imageData) {
    self.postMessage({ type: 'error', message: 'Frame kamera tidak tersedia.' } satisfies CameraWorkerErrorMessage)
    return
  }
  try {
    const frame = toImageData(message.imageData)
    const result = detector.detectForVideo(frame, message.timestamp)
    self.postMessage({ type: 'detection', detections: normalizeResult(result) } satisfies CameraWorkerDetectionMessage)
  } catch (error: unknown) {
    self.postMessage({ type: 'error', message: describeError(error) } satisfies CameraWorkerErrorMessage)
  }
}

self.onmessage = (event: MessageEvent<CameraWorkerRequest>) => {
  const message = event.data
  if (message.type === 'init') {
    void handleInit(message)
  } else if (message.type === 'detect') {
    handleDetect(message)
  }
}
