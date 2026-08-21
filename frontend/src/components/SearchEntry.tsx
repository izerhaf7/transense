// Home content-sheet search entry (demo).

import { useState } from 'react'
import type { FormEvent } from 'react'

import { SearchIcon } from '../icons'

export function SearchEntry() {
  const [query, setQuery] = useState('')
  const [feedback, setFeedback] = useState('')

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedQuery = query.trim()
    setFeedback(trimmedQuery ? `Entry pencarian demo: “${trimmedQuery}”` : 'Ketik halte atau rute untuk mencari.')
  }

  return (
    <section className="search-section" aria-labelledby="search-heading">
      <div className="section-heading">
        <p className="eyebrow">CARI PERJALANAN</p>
        <h2 id="search-heading">Mau ke halte mana?</h2>
      </div>
      <form className="search-form" onSubmit={handleSubmit} role="search">
        <label className="sr-only" htmlFor="route-search">Cari halte atau rute</label>
        <span className="search-form__icon" aria-hidden="true"><SearchIcon size={20} /></span>
        <input
          id="route-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Cari halte atau rute"
        />
        <button type="submit" aria-label="Cari halte atau rute">Cari</button>
      </form>
      {feedback ? <p className="search-feedback" role="status">{feedback}</p> : null}
    </section>
  )
}
