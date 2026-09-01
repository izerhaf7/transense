import { useCallback, useEffect, useMemo, useState } from 'react'

import ChatTranscribe from './ChatTranscribe'
import PlannerPage from './PlannerPage'
import NetraScan from './NetraScan'
import SideBySidePage from './SideBySidePage'
import { apiBaseUrl } from './api'
import { AppHeader } from './components/AppHeader'
import { BottomNavigation } from './components/BottomNavigation'
import { NotificationRenderer } from './components/NotificationRenderer'
import { useBackendConnection } from './connection'
import { clearStoredProfile, persistProfile, readProfile } from './profile'
import type { DemoProfile, ProfileType } from './profile'
import type { PlanPoint } from './plannerStorage'
import { DelaysPage } from './screens/DelaysPage'
import { HomePage } from './screens/HomePage'
import { Onboarding } from './screens/Onboarding'
import { ProfilePage } from './screens/ProfilePage'
import { SchedulePage } from './screens/SchedulePage'
import { SplashScreen } from './screens/SplashScreen'
import { createTtsProvider } from './tts'
import type { Screen } from './types'

function AntarAkuPage({
  profile,
  tts,
  onOpenSideBySide,
  onDestinationSelected,
}: {
  profile?: ProfileType
  tts?: ReturnType<typeof createTtsProvider>
  onOpenSideBySide: (stopId: string) => void
  onDestinationSelected: (point: PlanPoint | null) => void
}) {
  return (
    <PlannerPage
      apiBaseUrl={apiBaseUrl}
      profile={profile}
      tts={tts}
      onOpenSideBySide={onOpenSideBySide}
      onDestinationSelected={onDestinationSelected}
    />
  )
}

function MainShell({ profile, onResetProfile, onUpdateProfile }: { profile: DemoProfile; onResetProfile: () => void; onUpdateProfile: (patch: Partial<DemoProfile>) => void }) {
  const [screen, setScreen] = useState<Screen>('home')
  const [dismissedNotificationIds, setDismissedNotificationIds] = useState<string[]>([])
  const [plannerDestination, setPlannerDestination] = useState<PlanPoint | null>(null)
  const backend = useBackendConnection()
  const tts = useMemo(() => createTtsProvider(apiBaseUrl), [])
  const unreadNotifications = backend.notifications.filter((notification) => !dismissedNotificationIds.includes(notification.id))
  const unreadCount = unreadNotifications.length
  const currentNotification = backend.notifications.find((notification) => !dismissedNotificationIds.includes(notification.id)) || null

  // Simple wiring for the Antar Aku personalization hooks: side-by-side for the
  // daksa facility chips (full stopId context lands with the panorama task)
  // and netra-scan for the "Navigasi ke peron" arrival handoff.
  const handleOpenSideBySide = useCallback(() => {
    setScreen('side-by-side')
  }, [])
  const handlePlannerDestinationSelected = useCallback((point: PlanPoint | null) => {
    setPlannerDestination(point)
  }, [])

  const title = useMemo(() => {
    if (screen === 'home') return 'Beranda'
    if (screen === 'delays') return 'Keterlambatan'
    if (screen === 'profile') return 'Profil'
    if (screen === 'schedule') return 'Jadwal'
    if (screen === 'antar-aku') return 'Antar Aku'
    if (screen === 'transcribe') return 'Transcribe'
    if (screen === 'side-by-side') return 'Fasilitas halte'
    if (screen === 'netra-scan') return 'Pemindai Netra'
    return 'Fitur Transense'
  }, [screen])

  const handleNavigate = (nextScreen: Exclude<Screen, 'placeholder'>) => {
    setScreen(nextScreen)
  }

  const dismissNotification = (notificationId: string) => {
    setDismissedNotificationIds((current) => (current.includes(notificationId) ? current : [...current, notificationId]))
  }

  return (
    <div className={`app-frame${screen === 'home' || screen === 'transcribe' ? ' app-frame--home' : ''}`}>
      {screen === 'home' ? null : <AppHeader title={title} onBack={() => handleNavigate('home')} />}
      <NotificationRenderer notification={currentNotification} profile={profile.profile} tts={tts} onDismiss={() => {
        if (currentNotification) dismissNotification(currentNotification.id)
      }} />
      <div
        key={screen}
        className="screen-transition"
        style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }}
      >
        {screen === 'home' ? <HomePage displayName={profile.displayName} transitState={backend.transitState} notificationCount={unreadCount} notifications={unreadNotifications} onNavigate={handleNavigate} onDismissNotification={dismissNotification} profile={profile.profile} /> : null}
        {screen === 'schedule' ? <SchedulePage /> : null}
        {screen === 'delays' ? <DelaysPage incidentRecords={backend.incidentRecords} onPinIncident={backend.pinIncident} /> : null}
        {screen === 'transcribe' ? <ChatTranscribe apiBaseUrl={apiBaseUrl} /> : null}
        {screen === 'antar-aku' ? (
          <AntarAkuPage
            profile={profile.profile}
            tts={tts}
            onOpenSideBySide={handleOpenSideBySide}
            onDestinationSelected={handlePlannerDestinationSelected}
          />
        ) : null}
        {screen === 'profile' ? <ProfilePage profile={profile} onReset={onResetProfile} onUpdateProfile={onUpdateProfile} lastRampAck={backend.lastRampAck} sendRampRequest={backend.sendRampRequest} /> : null}
        {screen === 'side-by-side' ? <SideBySidePage apiBaseUrl={apiBaseUrl} profile={profile.profile} tts={tts} /> : null}
        {screen === 'netra-scan' ? <NetraScan apiBaseUrl={apiBaseUrl} tts={tts} destinationStop={plannerDestination} /> : null}
      </div>
      <BottomNavigation screen={screen} onNavigate={handleNavigate} />
    </div>
  )
}

export default function App() {
  const [profile, setProfile] = useState<DemoProfile | null>(() => readProfile())
  const [screen, setScreen] = useState<Screen>(() => (readProfile() ? 'home' : 'onboarding'))
  const [splashLeaving, setSplashLeaving] = useState(false)
  const [splashDone, setSplashDone] = useState(false)

  useEffect(() => {
    const leaveTimer = window.setTimeout(() => setSplashLeaving(true), 1400)
    const doneTimer = window.setTimeout(() => setSplashDone(true), 1900)
    return () => {
      window.clearTimeout(leaveTimer)
      window.clearTimeout(doneTimer)
    }
  }, [])

  const handleCompleteOnboarding = (displayName: string, profile: ProfileType = 'tuli') => {
    const nextProfile: DemoProfile = { displayName, profile, createdAt: new Date().toISOString() }
    if (persistProfile(nextProfile)) {
      setProfile(nextProfile)
      setScreen('home')
    }
  }

  const handleResetProfile = () => {
    if (clearStoredProfile()) {
      setProfile(null)
      setScreen('onboarding')
    }
  }

  const handleUpdateProfile = (patch: Partial<DemoProfile>) => {
    if (!profile) return
    const nextProfile: DemoProfile = { ...profile, ...patch }
    if (persistProfile(nextProfile)) {
      setProfile(nextProfile)
    }
  }

  if (!splashDone) {
    return <SplashScreen leaving={splashLeaving} />
  }

  if (!profile || screen === 'onboarding') {
    return <Onboarding onComplete={handleCompleteOnboarding} />
  }

  return <MainShell profile={profile} onResetProfile={handleResetProfile} onUpdateProfile={handleUpdateProfile} />
}
