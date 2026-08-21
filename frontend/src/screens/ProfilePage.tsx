// Profile screen: identity + output-channel personalization.

import { useState } from 'react'

import OccupancyCard from '../OccupancyCard'
import { apiBaseUrl } from '../api'
import type { DemoProfile } from '../profile'
import { OUTPUT_CHANNEL_LABELS, OUTPUT_CHANNEL_OPTIONS, PROFILE_OPTIONS } from '../profileOptions'

export function ProfilePage({ profile, onReset, onUpdateProfile, lastRampAck, sendRampRequest }: {
  profile: DemoProfile
  onReset: () => void
  onUpdateProfile?: (patch: Partial<DemoProfile>) => void
  lastRampAck: string | null
  sendRampRequest: (stopId: string) => void
}) {
  const [editOpen, setEditOpen] = useState(false)
  const profileLabel = PROFILE_OPTIONS.find((option) => option.type === profile.profile)?.label
    ?? profile.profile.charAt(0).toUpperCase() + profile.profile.slice(1)
  const outputChannel = profile.outputChannel ?? 'auto'

  return (
    <main className="page-content inner-page">
      <section className="page-intro">
        <p className="eyebrow">PROFIL / PERANGKAT INI</p>
        <h2>Profil</h2>
        <p>Identitas tersimpan lokal agar alur pembukaan berikutnya tetap singkat.</p>
      </section>
      <section className="profile-card" aria-labelledby="profile-card-heading">
        <span className="profile-avatar" aria-hidden="true">{profile.displayName.slice(0, 1).toUpperCase()}</span>
        <div>
          <p className="eyebrow">NAMA PANGGILAN</p>
          <h3 id="profile-card-heading">{profile.displayName}</h3>
          <p>Dibuat {new Date(profile.createdAt).toLocaleDateString('id-ID')}</p>
        </div>
      </section>
      <dl className="profile-fields">
        <div className="profile-field">
          <dt>Tipe disabilitas</dt>
          <dd>{profileLabel}</dd>
        </div>
        <div className="profile-field">
          <dt>Preferensi kanal keluaran</dt>
          <dd>{OUTPUT_CHANNEL_LABELS[outputChannel]}</dd>
        </div>
      </dl>
      {profile.profile === 'daksa' ? (
        <OccupancyCard apiBaseUrl={apiBaseUrl} sendRampRequest={sendRampRequest} lastRampAck={lastRampAck} />
      ) : null}
      <button
        className="secondary-button profile-edit-btn"
        type="button"
        onClick={() => setEditOpen((open) => !open)}
        aria-expanded={editOpen}
        aria-controls={editOpen ? 'profile-edit-panel' : undefined}
      >
        Ubah personalisasi
      </button>
      {editOpen ? (
        <section className="profile-edit-panel" id="profile-edit-panel" aria-label="Ubah personalisasi">
          <fieldset className="profile-edit-options">
            <legend>Preferensi kanal keluaran</legend>
            {OUTPUT_CHANNEL_OPTIONS.map((option) => (
              <label className="profile-edit-option" key={option.value}>
                <input
                  type="radio"
                  name="output-channel"
                  value={option.value}
                  checked={outputChannel === option.value}
                  onChange={() => onUpdateProfile?.({ outputChannel: option.value })}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
          <hr className="profile-edit-divider" />
          <button className="secondary-button profile-edit-danger" type="button" onClick={onReset}>Hapus profil</button>
        </section>
      ) : null}
      <p className="profile-version">Transense v0.1.0</p>
    </main>
  )
}
