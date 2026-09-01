/** Shared `navigator.vibrate` wrapper (Android-only; no-op elsewhere). */
export function vibrate(pattern: readonly number[]) {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator && typeof navigator.vibrate === 'function') {
    navigator.vibrate([...pattern])
  }
}
