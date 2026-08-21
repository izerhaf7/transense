// Bottom navigation bar (Beranda / Jadwal / Profil).

import type { ReactNode } from 'react'

import { HomeIcon, ScheduleIcon, UserIcon } from '../icons'
import type { Screen } from '../types'

export function BottomNavigation({ screen, onNavigate }: { screen: Screen; onNavigate: (screen: Exclude<Screen, 'placeholder'>) => void }) {
  const navigationItems: Array<{ screen: Exclude<Screen, 'placeholder'>; label: string; icon: ReactNode }> = [
    { screen: 'home', label: 'Beranda', icon: <HomeIcon size={20} /> },
    { screen: 'schedule', label: 'Jadwal', icon: <ScheduleIcon size={20} /> },
    { screen: 'profile', label: 'Profil', icon: <UserIcon size={20} /> },
  ]

  return (
    <nav className="bottom-nav" aria-label="Navigasi utama">
      {navigationItems.map((item) => {
        const isActive = screen === item.screen
        return (
          <button key={item.screen} className={`bottom-nav__item${isActive ? ' bottom-nav__item--active' : ''}`} type="button" onClick={() => onNavigate(item.screen)} aria-current={isActive ? 'page' : undefined}>
            <span className="bottom-nav__icon" aria-hidden="true">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
