// Per-profile notification banner + edge flash renderer.

import { useEffect, useRef, useState } from 'react'

import { notificationModifierClass, resolveNotificationOutput, shouldSpeakNotification } from '../notify'
import type { ProfileType } from '../profile'
import type { TtsProvider } from '../tts'
import type { NotificationRecord } from '../types'

export function NotificationRenderer({ notification, onDismiss, profile = 'tuli', tts }: {
  notification: NotificationRecord | null
  onDismiss: () => void
  profile?: ProfileType
  tts?: TtsProvider
}) {
  const [flashVisible, setFlashVisible] = useState(false)
  const lastSpokenIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!notification) {
      setFlashVisible(false)
      return
    }

    setFlashVisible(true)
    const output = resolveNotificationOutput(profile, notification)
    if (output.vibratePattern && 'vibrate' in navigator && typeof navigator.vibrate === 'function') {
      navigator.vibrate(output.vibratePattern)
    }
    if (output.speakText && shouldSpeakNotification(profile, notification, lastSpokenIdRef.current)) {
      lastSpokenIdRef.current = notification.id
      tts?.speak(output.speakText)
    }

    const expiry = window.setTimeout(onDismiss, 8000)
    return () => window.clearTimeout(expiry)
  }, [notification, profile, tts])

  if (!notification) return null
  const output = resolveNotificationOutput(profile, notification)
  const isDanger = notification.kind === 'incident' || notification.kind === 'off_route'
  return (
    <>
      {flashVisible ? <div className={`edge-flash edge-flash--${isDanger ? 'danger' : 'safe'}`} aria-hidden="true" /> : null}
      <section className={`notification-banner notification-banner--${isDanger ? 'danger' : 'safe'}${notificationModifierClass(output.renderMode)}`} role="alert" aria-live="assertive">
        <div>
          <p className="eyebrow">NOTIFIKASI VISUAL / AUDIO-BLIND</p>
          <h2>{notification.title}</h2>
          <p>{notification.message}</p>
          <small>{notification.kind === 'off_route' ? 'Simulasi debug · tanpa geolocation' : 'Teks dan visual adalah kanal utama; getar Android bersifat tambahan.'}</small>
        </div>
        <button className="notification-banner__dismiss" type="button" onClick={onDismiss} aria-label="Tutup notifikasi">Tutup</button>
      </section>
    </>
  )
}
