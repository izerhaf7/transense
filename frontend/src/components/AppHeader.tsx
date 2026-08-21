// Top app header with back button.

import { ArrowBackIcon } from '../icons'

export function AppHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <header className="app-header">
      <button type="button" className="app-header__back" onClick={onBack} aria-label="Kembali ke Beranda">
        <ArrowBackIcon />
      </button>
      <div className="app-header__title">
        <span className="brand-mark" aria-hidden="true"><img className="brand-logo-img" src="/logos/Logo-Transense.png" alt="" /></span>
        <div>
          <h1>{title}</h1>
        </div>
      </div>
    </header>
  )
}
