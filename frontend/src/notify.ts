/**
 * Per-profile notification decisions for Transense (multi-profil-netra-daksa
 * task 0.3: "render per active profile"). PURE frontend — no React, no DOM.
 *
 * The renderer in App.tsx stays thin: this module decides WHAT to do for a
 * given profile + notification (speak? vibrate? which banner presentation?),
 * and the component executes it. Because it is framework-free it can be
 * unit-tested in node (see notify-check.mjs) by transpiling in a VM, matching
 * the plannerStorage.ts / profile.ts pattern.
 *
 * Vibration patterns are deliberately NOT redefined here: they come from the
 * single source of truth in journey.ts (`VIBRATION_PATTERNS`), so journey.ts
 * stays the contract owner.
 */

import { VIBRATION_PATTERNS } from './journey'
import type { ProfileType } from './profile'

export type NotificationKind = 'vehicle_approaching' | 'destination_approaching' | 'incident' | 'off_route'

export type NotificationRenderMode = 'standard' | 'netra' | 'daksa'

export interface NotificationRecordLike {
  id: string
  kind: NotificationKind
  title: string
  message: string
}

export interface NotificationOutput {
  /** Text for audio-first (netra) profiles to hear; null for visual profiles. */
  speakText: string | null
  /** Vibration pattern to play; null when the kind has none (off_route). */
  vibratePattern: readonly number[] | null
  /** Banner presentation mode for the active profile. */
  renderMode: NotificationRenderMode
}

const VIBRATION_BY_KIND: Partial<Record<NotificationKind, readonly number[]>> = {
  vehicle_approaching: VIBRATION_PATTERNS.vehicleApproaching,
  destination_approaching: VIBRATION_PATTERNS.destinationApproaching,
  incident: VIBRATION_PATTERNS.incident,
  // off_route intentionally has no vibration pattern (audio-blind default).
}

/** Per-profile decision for one notification. */
export function resolveNotificationOutput(profile: ProfileType, record: NotificationRecordLike): NotificationOutput {
  const renderMode: NotificationRenderMode = profile === 'netra' ? 'netra' : profile === 'daksa' ? 'daksa' : 'standard'
  const speakText = profile === 'netra' ? `${record.title}. ${record.message}` : null
  const vibratePattern = VIBRATION_BY_KIND[record.kind] ?? null
  return { speakText, vibratePattern, renderMode }
}

/**
 * Audio-first (netra) profiles speak only when a NEW notification arrives:
 * re-renders of the same id must never re-speak. Tuli and daksa never speak.
 */
export function shouldSpeakNotification(profile: ProfileType, record: NotificationRecordLike, lastSpokenId: string | null): boolean {
  return profile === 'netra' && record.id !== lastSpokenId
}

/**
 * Banner modifier class for the render mode. Returns '' for 'standard' so the
 * tuli banner markup stays byte-identical to the pre-profile behavior.
 */
export function notificationModifierClass(renderMode: NotificationRenderMode): string {
  return renderMode === 'standard' ? '' : ` notification-banner--${renderMode}`
}
