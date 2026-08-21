// Profile picker + output-channel option constants (shared by Onboarding and ProfilePage).

import type { ReactNode } from 'react'

import { AccessibilityIcon, BellIcon, TranscribeIcon } from './icons'
import type { OutputChannel, ProfileType } from './profile'

export const PROFILE_OPTIONS: { type: ProfileType; label: string; description: string; icon: ReactNode }[] = [
  {
    type: 'tuli',
    label: 'Tuli',
    description: 'Audio-blind: teks besar, kontras tinggi, getar',
    icon: <TranscribeIcon />,
  },
  {
    type: 'netra',
    label: 'Netra',
    description: 'Audio-first: suara membacakan informasi',
    icon: <BellIcon />,
  },
  {
    type: 'daksa',
    label: 'Daksa',
    description: 'Visual + info fasilitas kursi roda',
    icon: <AccessibilityIcon />,
  },
]

export const OUTPUT_CHANNEL_OPTIONS: { value: OutputChannel; label: string }[] = [
  { value: 'visual', label: 'Visual' },
  { value: 'haptic', label: 'Getar' },
  { value: 'audio', label: 'Audio' },
  { value: 'auto', label: 'Otomatis' },
]

export const OUTPUT_CHANNEL_LABELS: Record<OutputChannel, string> = {
  visual: 'Visual',
  haptic: 'Getar',
  audio: 'Audio',
  auto: 'Otomatis (sesuai profil)',
}
