import { useEffect, useRef, useState } from 'react'
import { useScribe } from '@elevenlabs/react'

type Sender = 'user' | 'other'

interface ChatMessage {
  id: string
  sender: Sender
  text: string
  timestamp: string
  source: 'typed' | 'stt'
}

interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  created_at: string
  updated_at: string
}

interface ChatTranscribeProps {
  apiBaseUrl: string
}

function ChatTranscribe({ apiBaseUrl }: ChatTranscribeProps) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [active, setActive] = useState<Conversation | null>(null)
  const [draft, setDraft] = useState('')
  const [listening, setListening] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [inputMode, setInputMode] = useState<'mic' | 'keyboard'>('keyboard')
  const [typingAs, setTypingAs] = useState<Sender>('user')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<Conversation | null>(null)

  const loadConversations = async () => {
    try {
      const res = await fetch(`${apiBaseUrl}/api/conversations`)
      if (!res.ok) return
      const data = await res.json() as { conversations: Conversation[] }
      setConversations(data.conversations ?? [])
    } catch (error) {
      console.warn('Failed to load conversations.', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadConversations()
  }, [])

  const scribe = useScribe({
    modelId: 'scribe_v2_realtime',
    onCommittedTranscript: (data: { text: string }) => {
      const text = data.text.trim()
      if (!text) return
      void appendMessage('other', text, 'stt')
    },
    onError: (error: Error | Event) => {
      setErrorMessage(error instanceof Error ? error.message : 'Terjadi error pada sesi transkripsi.')
    },
    onDisconnect: () => {
      setListening(false)
    },
  })

  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [active?.messages.length])

  useEffect(() => {
    return () => {
      scribe.disconnect()
    }
  }, [scribe])

  const appendMessage = async (sender: Sender, text: string, source: 'typed' | 'stt') => {
    const trimmed = text.trim()
    if (!trimmed) return
    const message: ChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sender,
      text: trimmed,
      timestamp: new Date().toISOString(),
      source,
    }

    const current = activeRef.current
    if (current) {
      const next = { ...current, messages: [...current.messages, message] }
      setActive(next)
      try {
        const res = await fetch(`${apiBaseUrl}/api/conversations/${encodeURIComponent(current.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: next.title, messages: next.messages }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const saved = await res.json() as Conversation
        setActive(saved)
      } catch (error) {
        setErrorMessage('Gagal menyimpan pesan ke backend.')
        console.warn('Save message failed.', error)
      }
      void loadConversations()
      return
    }

    try {
      const res = await fetch(`${apiBaseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed.slice(0, 40), messages: [message] }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const created = await res.json() as Conversation
      setActive(created)
      setConversations((list) => [created, ...list])
    } catch (error) {
      setErrorMessage('Gagal membuat percakapan baru.')
      console.warn('Create conversation failed.', error)
    }
  }

  const startListening = async () => {
    setErrorMessage('')
    setListening(true)
    try {
      const response = await fetch(`${apiBaseUrl}/api/scribe-token`)
      if (!response.ok) {
        const errText = await response.text()
        setErrorMessage(`Gagal mendapatkan token: ${errText}`)
        setListening(false)
        return
      }
      const tokenData: { token: string } = await response.json()
      await scribe.connect({
        token: tokenData.token,
        microphone: { echoCancellation: true, noiseSuppression: true },
      })
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : 'Gagal memulai transkripsi ElevenLabs.')
      setListening(false)
    }
  }

  const stopListening = () => {
    scribe.disconnect()
    setListening(false)
  }

  const sendDraft = (sender: Sender) => {
    const text = draft.trim()
    if (!text) return
    void appendMessage(sender, text, 'typed')
    setDraft('')
  }

  const newConversation = () => {
    setActive(null)
    setHistoryOpen(false)
  }

  const openConversation = (conv: Conversation) => {
    setActive(conv)
    setHistoryOpen(false)
  }

  const removeConversation = async (id: string) => {
    try {
      const res = await fetch(`${apiBaseUrl}/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setConversations((list) => list.filter((c) => c.id !== id))
      if (active?.id === id) setActive(null)
    } catch (error) {
      console.warn('Delete conversation failed.', error)
    }
  }

  return (
    <main className="chat-page">
      <section className="chat-intro">
        <div>
          <p className="eyebrow">TRANSCRIBE / PERCAKAPAN</p>
          <h2>{active ? active.title : 'Percakapan baru'}</h2>
        </div>
        <div className="chat-intro__actions">
          <button className="secondary-button" type="button" onClick={() => setHistoryOpen((v) => !v)}>
            Riwayat ({conversations.length})
          </button>
          <button className="secondary-button" type="button" onClick={newConversation}>
            Baru
          </button>
        </div>
      </section>

      {historyOpen ? (
        <section className="chat-history" aria-label="Riwayat percakapan">
          {loading ? <div className="empty-state"><h3>Memuat…</h3></div> : null}
          {!loading && conversations.length ? conversations.map((conv) => (
            <button className="chat-history__card" type="button" key={conv.id} onClick={() => openConversation(conv)}>
              <div className="chat-history__card-body">
                <strong>{conv.title || 'Percakapan'}</strong>
                <span>{new Date(conv.updated_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
              </div>
              <span className="chat-history__card-count">{conv.messages.length}</span>
              <button className="chat-history__delete" type="button" onClick={(event) => { event.stopPropagation(); void removeConversation(conv.id) }} aria-label="Hapus percakapan">✕</button>
            </button>
          )) : null}
          {!loading && !conversations.length ? (
            <div className="empty-state"><h3>Belum ada riwayat</h3><p>Mulai percakapan untuk menyimpannya di server.</p></div>
          ) : null}
        </section>
      ) : (
        <>
          <div className="chat-messages" ref={scrollRef} aria-live="polite">
            {active && active.messages.length ? active.messages.map((message) => (
              <div className={`chat-bubble chat-bubble--${message.sender}`} key={message.id}>
                <span className="chat-bubble__label">{message.sender === 'user' ? 'Kamu' : 'Lawan bicara'}</span>
                <p>{message.text}</p>
                <time dateTime={message.timestamp}>{new Date(message.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</time>
              </div>
            )) : (
              <div className="chat-empty">
                <strong>Belum ada percakapan</strong>
                <span>Ketik pesanmu, atau tap mikrofon untuk menangkap ucapan lawan bicara.</span>
              </div>
            )}
            {listening && scribe.partialTranscript ? (
              <div className="chat-bubble chat-bubble--other chat-bubble--partial">
                <span className="chat-bubble__label">Lawan bicara</span>
                <p>{scribe.partialTranscript}<span className="live-transcript__caret" aria-hidden="true">|</span></p>
              </div>
            ) : null}
          </div>

          {errorMessage ? (
            <div className="notice-box notice-box--danger" role="alert"><strong>Gagal tersambung</strong><span>{errorMessage}</span></div>
          ) : null}

          <div className="chat-composer">
        <div className="chat-composer__modes">
          <button
            className={`chat-mode-btn${inputMode === 'keyboard' ? ' chat-mode-btn--active' : ''}`}
            type="button"
            onClick={() => setInputMode('keyboard')}
            aria-label="Mode ketik"
            title="Mode ketik"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
              <path fill="currentColor" d="M2 5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-4 3v-3H4a2 2 0 0 1-2-2V5Zm4 2v2h2V7H6Zm4 0v2h2V7h-2Zm4 0v2h2V7h-2Z" />
            </svg>
            <span>Ketik</span>
          </button>
          <button
            className={`chat-mode-btn${inputMode === 'mic' ? ' chat-mode-btn--active' : ''}`}
            type="button"
            onClick={() => setInputMode('mic')}
            aria-label="Mode mikrofon"
            title="Mode mikrofon"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22">
              <path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" />
            </svg>
            <span>Mikrofon</span>
          </button>
        </div>

        {inputMode === 'mic' ? (
          <div className="chat-composer__mic">
            <button
              className={`chat-mic-btn${listening ? ' chat-mic-btn--active' : ''}`}
              type="button"
              onClick={listening ? stopListening : startListening}
              aria-label={listening ? 'Hentikan mendengarkan' : 'Mulai mendengarkan lawan bicara'}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" width="28" height="28">
                <path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" />
              </svg>
            </button>
            <p className="chat-composer__mic-label">{listening ? 'Mendengarkan lawan bicara…' : 'Ketuk untuk mendengar lawan bicara'}</p>
          </div>
        ) : (
          <div className="chat-composer__keyboard">
            <div className="chat-composer__who">
              <button
                className={`chat-who-btn${typingAs === 'user' ? ' chat-who-btn--active' : ''}`}
                type="button"
                onClick={() => setTypingAs('user')}
              >
                Kamu
              </button>
              <button
                className={`chat-who-btn chat-who-btn--other${typingAs === 'other' ? ' chat-who-btn--active' : ''}`}
                type="button"
                onClick={() => setTypingAs('other')}
              >
                Lawan bicara
              </button>
            </div>
            <div className="chat-composer__row">
              <input
                className="chat-composer__input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') sendDraft(typingAs) }}
                placeholder={typingAs === 'user' ? 'Ketik pesanmu…' : 'Ketik ucapan lawan bicara…'}
                aria-label="Ketik pesan"
              />
              <button className="chat-composer__send" type="button" onClick={() => sendDraft(typingAs)} aria-label="Kirim">
                Kirim ↗
              </button>
            </div>
          </div>
        )}
      </div>
        </>
      )}
    </main>
  )
}

export default ChatTranscribe
