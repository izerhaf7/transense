// Onboarding: profile selection + display name (two-step wizard).

import { useState } from 'react'
import type { FormEvent } from 'react'

import { ArrowBackIcon, ArrowRightIcon } from '../icons'
import type { ProfileType } from '../profile'
import { PROFILE_OPTIONS } from '../profileOptions'

export function Onboarding({ onComplete }: { onComplete: (displayName: string, profile: ProfileType) => void }) {
  const [step, setStep] = useState<'profile' | 'name'>('profile')
  const [selectedProfile, setSelectedProfile] = useState<ProfileType | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedName = displayName.trim()
    if (!trimmedName) {
      setErrorMessage('Nama belum diisi. Masukkan nama untuk melanjutkan.')
      return
    }

    setErrorMessage('')
    onComplete(trimmedName, selectedProfile ?? 'tuli')
  }

  return (
    <main className="onboarding-frame">
      <div className="onboarding-panel">
        <div className="brand-lockup" aria-label="Transense">
          <span className="brand-lockup__mark" aria-hidden="true"><img className="brand-logo-img" src="/logos/Logo-Transense.png" alt="" /></span>
          <span className="brand-lockup__text">TRANSENSE</span>
        </div>
        {step === 'profile' ? (
          <>
            <p className="eyebrow">PILIH PROFIL</p>
            <h1>Bagaimana cara kamu paling nyaman menerima informasi?</h1>
            <p className="onboarding-copy">
              Pilih profil yang paling sesuai. Profil demo ini disimpan hanya di perangkatmu, tanpa login produksi.
            </p>
            <div className="profile-picker" role="group" aria-label="Pilih profil">
              {PROFILE_OPTIONS.map((option) => (
                <button
                  key={option.type}
                  type="button"
                  aria-pressed={selectedProfile === option.type}
                  className={`profile-card${selectedProfile === option.type ? ' profile-card--selected' : ''}`}
                  onClick={() => setSelectedProfile(option.type)}
                >
                  <span className="profile-card__icon" aria-hidden="true">{option.icon}</span>
                  <span className="profile-card__text">
                    <span className="profile-card__title">{option.label}</span>
                    <span className="profile-card__desc">{option.description}</span>
                  </span>
                </button>
              ))}
            </div>
            <button className="primary-button" type="button" disabled={!selectedProfile} onClick={() => setStep('name')}>
              Lanjut <span aria-hidden="true"><ArrowRightIcon size={20} /></span>
            </button>
          </>
        ) : (
          <>
            <button className="secondary-button onboarding-back" type="button" onClick={() => setStep('profile')}>
              <span aria-hidden="true"><ArrowBackIcon size={20} /></span> Pilih ulang profil
            </button>
            <p className="eyebrow">ISI NAMA</p>
            <h1>Mobilitas sepatutnya mudah untuk semua.</h1>
            <p className="onboarding-copy">
              Mulai dengan nama panggilan. Profil demo ini disimpan hanya di perangkatmu, tanpa login produksi.
            </p>
            <form className="onboarding-form" onSubmit={handleSubmit} noValidate>
              <label htmlFor="display-name">Nama panggilan</label>
              <input
                id="display-name"
                name="displayName"
                value={displayName}
                onChange={(event) => {
                  setDisplayName(event.target.value)
                  if (errorMessage) {
                    setErrorMessage('')
                  }
                }}
                placeholder="Contoh: Dita"
                autoComplete="nickname"
                aria-invalid={Boolean(errorMessage)}
                aria-describedby={errorMessage ? 'display-name-error' : undefined}
              />
              {errorMessage ? <p id="display-name-error" className="form-error" role="alert">{errorMessage}</p> : null}
              <button className="primary-button" type="submit">Masuk ke Transense <span aria-hidden="true"><ArrowRightIcon size={20} /></span></button>
            </form>
            <p className="onboarding-note">Tampilan dirancang audio-blind: status selalu terlihat di layar.</p>
          </>
        )}
      </div>
    </main>
  )
}
