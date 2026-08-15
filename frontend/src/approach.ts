/**
 * Netra approach heuristic: decide WHEN an approaching bus triggers the TTS +
 * vibration cue and WHAT to say. PURE — no React, no DOM, no fetch — so it can
 * be unit-tested in node (see approach-check.mjs), matching the notify.ts
 * pattern.
 *
 * Pipeline: CameraScan yields a detection list per frame; `chooseNextDetection`
 * folds them into one tracked box (same-object continuity wins, else the higher
 * score); `isApproaching` compares the tracked box to its predecessor and fires
 * when it grew more than the threshold; `buildAnnouncement` turns the tracked
 * detection + OCR corridor into the deterministic Indonesian sentence the TTS
 * provider speaks.
 */

export interface DetectionBox {
  x: number
  y: number
  width: number
  height: number
}

export interface Detection {
  box: DetectionBox
  score: number
}

/** Box diagonal in pixels — a single growth measure covering both dimensions. */
function boxSize(box: DetectionBox): number {
  return Math.hypot(box.width, box.height)
}

/**
 * True when the box grew by more than `growthThreshold` (default 15%) from the
 * previously tracked detection. Requires a previous detection; a brand-new
 * detection (prev === null) is never "approaching" yet.
 */
export function isApproaching(prev: Detection | null, next: Detection, growthThreshold = 0.15): boolean {
  if (prev === null) {
    return false
  }
  const previousSize = boxSize(prev.box)
  if (previousSize <= 0) {
    return false
  }
  const growth = (boxSize(next.box) - previousSize) / previousSize
  return growth > growthThreshold
}

/**
 * Intersection-over-union between two boxes in video-pixel coordinates — the
 * "IoU-ish" continuity signal used by `chooseNextDetection`.
 */
export function boxIoU(a: DetectionBox, b: DetectionBox): number {
  const intersectionWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const intersectionHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  const intersection = intersectionWidth * intersectionHeight
  const union = a.width * a.height + b.width * b.height - intersection
  return union <= 0 ? 0 : intersection / union
}

/**
 * Simple deterministic tracker over one new candidate: a box overlapping the
 * tracked one is the same bus growing, so keep the newest frame (the growth
 * ratio needs it); a non-overlapping box is a different object, so the
 * higher-confidence detection wins over a flickering false positive.
 */
export function chooseNextDetection(prev: Detection | null, next: Detection, iouThreshold = 0.3): Detection {
  if (prev === null) {
    return next
  }
  if (boxIoU(prev.box, next.box) >= iouThreshold) {
    return next
  }
  return next.score >= prev.score ? next : prev
}

/**
 * Deterministic Indonesian announcement for the tracked detection. The OCR
 * corridor (e.g. "1") is included only when present; an empty/whitespace OCR
 * result is a valid empty reading, never a fabricated corridor. Low-confidence
 * detections stay honest with a spoken qualifier; high-confidence boxes match
 * the canonical text byte-for-byte.
 */
export function buildAnnouncement(detection: Detection, ocrText: string | null): string {
  const corridor = ocrText && ocrText.trim() ? ` Koridor ${ocrText.trim()}.` : ''
  const confidenceNote = detection.score >= 0.9 ? '' : ' Keyakinan rendah.'
  return `Bus terdeteksi.${corridor} Armada mendekat.${confidenceNote}`
}
