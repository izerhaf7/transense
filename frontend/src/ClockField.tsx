import { useEffect, useRef, useState } from 'react'
import type { FocusEvent, KeyboardEvent, WheelEvent } from 'react'
import { ChevronDownIcon, ChevronUpIcon, CloseIcon } from './icons'

/**
 * 24-hour clock input ("HH:MM", no AM/PM) that can be typed directly,
 * nudged with the keyboard arrows / mouse wheel, or stepped with buttons.
 * Empty string means "not set" (the field is optional).
 */
const pad2 = (n: number): string => String(n).padStart(2, '0')

function parseSegment(text: string, fallback: number): number {
  const n = Number.parseInt(text, 10)
  return Number.isNaN(n) ? fallback : n
}

function wrap(value: number, max: number): number {
  return ((value % max) + max) % max
}

export interface ClockFieldProps {
  value: string // "" | "HH:MM"
  onChange: (value: string) => void
  /** a11y name, e.g. "jam berangkat". */
  label: string
}

export default function ClockField({ value, onChange, label }: ClockFieldProps) {
  const [hour, setHour] = useState('')
  const [minute, setMinute] = useState('')

  // Live values tracked in refs so rapid button clicks never read stale
  // render-closure state; the useState mirrors stay in sync for rendering.
  const hourRef = useRef<HTMLInputElement | null>(null)
  const minuteRef = useRef<HTMLInputElement | null>(null)
  const liveHour = useRef('')
  const liveMinute = useRef('')
  const lastValidRef = useRef(value)

  const setSegment = (kind: 'hour' | 'minute', text: string) => {
    if (kind === 'hour') {
      liveHour.current = text
      setHour(text)
    } else {
      liveMinute.current = text
      setMinute(text)
    }
  }

  // Sync from the parent (initial value or an external reset).
  useEffect(() => {
    lastValidRef.current = value
    const [h = '', m = ''] = value ? value.split(':') : ['', '']
    liveHour.current = h
    liveMinute.current = m
    setHour(h)
    setMinute(m)
  }, [value])

  const emit = (h: string, m: string) => {
    if (!h && !m) {
      onChange('')
      return
    }
    const hh = pad2(parseSegment(h, 0) % 24)
    const mm = pad2(parseSegment(m, 0) % 60)
    const next = `${hh}:${mm}`
    lastValidRef.current = next
    onChange(next)
  }

  /** Nudge one segment; an empty sibling segment is treated as 00. */
  const step = (kind: 'hour' | 'minute', direction: 1 | -1) => {
    if (kind === 'hour') {
      const base = liveHour.current === '' ? 0 : parseSegment(liveHour.current, 0)
      const next = pad2(wrap(base + direction, 24))
      setSegment('hour', next)
      emit(next, liveMinute.current === '' ? '00' : liveMinute.current)
    } else {
      const base = liveMinute.current === '' ? 0 : parseSegment(liveMinute.current, 0)
      const next = pad2(wrap(base + direction, 60))
      setSegment('minute', next)
      emit(liveHour.current === '' ? '00' : liveHour.current, next)
    }
  }

  const onWheel = (event: WheelEvent<HTMLInputElement>, kind: 'hour' | 'minute') => {
    if (event.deltaY === 0) return
    event.preventDefault()
    step(kind, event.deltaY < 0 ? 1 : -1)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>, kind: 'hour' | 'minute') => {
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      step(kind, 1)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      step(kind, -1)
    } else if (event.key === 'Enter') {
      event.currentTarget.blur()
    }
  }

  const onSegmentInput = (kind: 'hour' | 'minute', text: string) => {
    const digits = text.replace(/\D/g, '').slice(0, 2)
    if (kind === 'hour') {
      setSegment('hour', digits)
      if (digits.length === 2) minuteRef.current?.focus()
    } else {
      setSegment('minute', digits)
      if (digits.length === 2) {
        emit(liveHour.current === '' ? pad2(0) : liveHour.current, digits)
        minuteRef.current?.blur()
      }
    }
  }

  /**
   * Commit on blur; cancel partial edits back to the last committed value.
   * Moving between the two segments (hour -> minute auto-advance) is not a
   * real leave, so a partial hour is preserved while the minute is typed.
   */
  const onSegmentBlur = (event: FocusEvent<HTMLInputElement>) => {
    const next = event.relatedTarget as HTMLElement | null
    if (next === minuteRef.current || next === hourRef.current) return
    if (!liveHour.current && !liveMinute.current) {
      onChange('')
      return
    }
    if (!liveHour.current || !liveMinute.current) {
      const [h = '', m = ''] = lastValidRef.current ? lastValidRef.current.split(':') : ['', '']
      liveHour.current = h
      liveMinute.current = m
      setHour(h)
      setMinute(m)
      return
    }
    emit(liveHour.current, liveMinute.current)
  }

  const clear = () => {
    lastValidRef.current = ''
    liveHour.current = ''
    liveMinute.current = ''
    setHour('')
    setMinute('')
    onChange('')
  }

  const hasValue = value !== ''

  return (
    <div className="clock-field" role="group" aria-label={label}>
      <span className="clock-field__seg">
        <button
          type="button"
          className="clock-field__step"
          aria-label={`${label} jam berkurang`}
          onClick={() => step('hour', -1)}
        >
          <ChevronDownIcon size={16} />
        </button>
        <input
          ref={hourRef}
          className="clock-field__num"
          value={hour}
          onChange={(event) => onSegmentInput('hour', event.target.value)}
          onWheel={(event) => onWheel(event, 'hour')}
          onKeyDown={(event) => onKeyDown(event, 'hour')}
          onBlur={onSegmentBlur}
          onFocus={(event) => event.currentTarget.select()}
          inputMode="numeric"
          maxLength={2}
          autoComplete="off"
          aria-label={`${label} jam`}
          placeholder="HH"
        />
        <button
          type="button"
          className="clock-field__step"
          aria-label={`${label} jam bertambah`}
          onClick={() => step('hour', 1)}
        >
          <ChevronUpIcon size={16} />
        </button>
      </span>
      <span className="clock-field__colon" aria-hidden="true">:</span>
      <span className="clock-field__seg">
        <button
          type="button"
          className="clock-field__step"
          aria-label={`${label} menit berkurang`}
          onClick={() => step('minute', -1)}
        >
          <ChevronDownIcon size={16} />
        </button>
        <input
          ref={minuteRef}
          className="clock-field__num"
          value={minute}
          onChange={(event) => onSegmentInput('minute', event.target.value)}
          onWheel={(event) => onWheel(event, 'minute')}
          onKeyDown={(event) => onKeyDown(event, 'minute')}
          onBlur={onSegmentBlur}
          onFocus={(event) => event.currentTarget.select()}
          inputMode="numeric"
          maxLength={2}
          autoComplete="off"
          aria-label={`${label} menit`}
          placeholder="MM"
        />
        <button
          type="button"
          className="clock-field__step"
          aria-label={`${label} menit bertambah`}
          onClick={() => step('minute', 1)}
        >
          <ChevronUpIcon size={16} />
        </button>
      </span>
      {hasValue ? (
        <button
          type="button"
          className="clock-field__clear"
          aria-label={`Hapus ${label}`}
          onClick={clear}
        >
          <CloseIcon size={16} />
        </button>
      ) : null}
    </div>
  )
}
