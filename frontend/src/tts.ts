/**
 * Text-to-speech for Transense. FRAMEWORK-FREE (no React) so it can be
 * unit-tested in node (see tts-check.mjs): uses only global `fetch`, `Audio`,
 * and `URL.createObjectURL`.
 *
 * The backend exposes `POST /api/tts` (audio/mpeg bytes from ElevenLabs). This
 * provider posts the text, caches the resulting blob URL per normalized text
 * (so repeat reads never re-request), and plays it back with `new Audio`.
 *
 * Audio output is a *supplement* to the visible text, never the only cue:
 * `speak` never throws — on any failure it calls the optional `onFallback`
 * callback (the caller renders the text visibly) and resolves gracefully.
 */

export interface TtsProviderOptions {
  /** Backend origin, e.g. `http://localhost:8000` (trailing slash is stripped). */
  apiBaseUrl: string
  /** Called with the normalized text when synthesis/playback fails. */
  onFallback?: (text: string) => void
}

export class TtsProvider {
  private readonly apiBaseUrl: string
  private readonly onFallback: ((text: string) => void) | undefined
  private readonly audioCache = new Map<string, string>()

  constructor(options: TtsProviderOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/$/, '')
    this.onFallback = options.onFallback
  }

  /** Synthesize and play `text`. Resolves gracefully; never rejects. */
  async speak(text: string): Promise<void> {
    const normalized = text.trim()
    if (!normalized) {
      return
    }
    try {
      const audioUrl = await this.fetchAudioUrl(normalized)
      await this.playUrl(audioUrl)
    } catch (error: unknown) {
      console.warn('Transense TTS unavailable, falling back to visible text.', error)
      this.onFallback?.(normalized)
    }
  }

  private async fetchAudioUrl(text: string): Promise<string> {
    const cached = this.audioCache.get(text)
    if (cached) {
      return cached
    }
    const response = await fetch(`${this.apiBaseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!response.ok) {
      throw new Error(`TTS request failed with status ${response.status}`)
    }
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    this.audioCache.set(text, url)
    return url
  }

  private async playUrl(url: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const audio = new Audio(url)
      audio.onended = () => resolve()
      audio.onerror = () => reject(new Error('TTS audio playback failed'))
      audio.play().catch(reject)
    })
  }
}

export function createTtsProvider(apiBaseUrl: string, onFallback?: (text: string) => void): TtsProvider {
  return new TtsProvider({ apiBaseUrl, onFallback })
}
