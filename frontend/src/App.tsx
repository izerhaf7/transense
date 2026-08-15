import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import ChatTranscribe from './ChatTranscribe'
import PlannerPage from './PlannerPage'
import {
  cloneTransitState,
  SEEDED_TRANSIT_STATE,
  VIBRATION_PATTERNS,
} from './journey'
import type { Eta, Incident, Route, Stop, TransitState, Trip, Vehicle } from './journey'
import MapboxMap, { type StopPopupData, type RailStationPopupData } from './MapboxMap'
import { AntarAkuIcon, BellIcon, DelaysIcon, MaximizeIcon, MinimizeIcon, ScheduleIcon, TranscribeIcon } from './icons'
import { clearStoredProfile, persistProfile, readProfile } from './profile'
import type { DemoProfile, ProfileType } from './profile'

type Screen = 'onboarding' | 'home' | 'delays' | 'profile' | 'schedule' | 'antar-aku' | 'transcribe' | 'placeholder'
type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline'
type NotificationKind = 'vehicle_approaching' | 'destination_approaching' | 'incident' | 'off_route'
type MicrophonePermission = 'unknown' | 'granted' | 'denied' | 'unsupported'
type TranscriptionSource = 'live' | 'mock' | 'degraded'

interface ConnectionState {
  status: ConnectionStatus
  detail: string
  attempts: number
}

interface ConnectionAck {
  type: 'connection.ack'
  protocol: 'transit-demo.v1'
  state: TransitState
}

interface TransitUpdate {
  type: 'transit.update'
  event_id: string
  vehicle_id: string
  eta_minutes: number
  position: string
  occurred_at: string
  state_version: number
}

interface TransitReset {
  type: 'transit.reset'
  state: TransitState
  occurred_at: string
  state_version: number
}

interface TransitError {
  type: 'error'
  code: string
  message: string
}

interface TranscriptionResultMessage {
  type: 'transcription.result'
  id: string
  session_id: string
  text: string
  created_at: string
  provider: 'live' | 'mock'
}

interface TranscriptionSessionStartedMessage {
  type: 'transcription.session.started'
  session_id: string
  source: 'conversation_microphone'
  provider: 'cloud' | 'mock'
  mode: 'live' | 'mock'
}

interface TranscriptionErrorMessage {
  type: 'transcription.session.error'
  session_id?: string
  code: string
  message: string
}

type TransitMessage = ConnectionAck | TransitUpdate | TransitReset | TransitError | TranscriptionResultMessage | TranscriptionSessionStartedMessage | TranscriptionErrorMessage

interface NotificationBase {
  type: `notification.${Exclude<NotificationKind, 'off_route'>}`
  event_id: string
  occurred_at: string
  route_id?: string
  message?: string
}

interface VehicleApproachingNotification extends NotificationBase {
  type: 'notification.vehicle_approaching'
  vehicle_id: string
  stop_id: string
  eta_minutes: number
}

interface DestinationApproachingNotification extends NotificationBase {
  type: 'notification.destination_approaching'
  vehicle_id: string
  stop_id: string
  eta_minutes: number
}

interface IncidentNotification extends NotificationBase {
  type: 'notification.incident'
  incident_id: string
  status: string
  cause: string
  action: string
  instruction: string
  updated_at: string
}

interface OffRouteNotification {
  type: 'journey.off_route'
  event_id: string
  occurred_at: string
  route_id?: string
  status?: 'warning' | 'resolved'
  message: string
}

type TransitNotification = VehicleApproachingNotification | DestinationApproachingNotification | IncidentNotification | OffRouteNotification
type TransitMessageWithNotifications = TransitMessage | TransitNotification

interface TranscriptRecord {
  id: string
  sessionId: string
  text: string
  createdAt: string
  provider: 'live' | 'mock'
  pinned: boolean
  simulated: boolean
}

interface TranscriptionSessionState {
  status: 'idle' | 'requesting' | 'active' | 'stopping' | 'denied'
  source: TranscriptionSource
  sessionId: string | null
  detail: string
}

interface TranscriptionController {
  microphone: MicrophonePermission
  session: TranscriptionSessionState
  current: TranscriptRecord | null
  history: TranscriptRecord[]
  historyDetail: string
  start: () => void
  stop: () => void
  pin: (transcriptId: string) => void
  saveTranscript: (text: string) => void
}

interface NotificationRecord {
  id: string
  kind: NotificationKind
  title: string
  message: string
  occurredAt: string
  incident?: IncidentRecord
  offRouteStatus?: 'warning' | 'resolved'
}

interface IncidentRecord {
  id: string
  routeId: string
  status: string
  cause: string
  action: string
  instruction: string
  updatedAt: string
  pinned: boolean
  simulated: boolean
}

interface BackendConnection {
  connection: ConnectionState
  transitState: TransitState | null
  simulationDetail: string
  notifications: NotificationRecord[]
  incidentRecords: IncidentRecord[]
  transcription: TranscriptionController
  updateTransit: () => void
  resetTransit: () => void
  simulateNotification: (kind: Exclude<NotificationKind, 'off_route'>) => void
  pinIncident: (incidentId: string) => void
  saveTranscript: (text: string) => void
}

const DEFAULT_API_BASE_URL = 'http://localhost:8000'
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/$/, '')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStop(value: unknown): value is Stop {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
}

function isRoute(value: unknown): value is Route {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' && Array.isArray(value.stop_ids) && value.stop_ids.every((stopId) => typeof stopId === 'string')
}

function isTrip(value: unknown): value is Trip {
  return isRecord(value) && typeof value.id === 'string' && typeof value.route_id === 'string' && typeof value.vehicle_id === 'string'
}

function isVehicle(value: unknown): value is Vehicle {
  return isRecord(value) && typeof value.id === 'string' && typeof value.trip_id === 'string' && typeof value.position === 'string' && typeof value.eta_minutes === 'number'
}

function isEta(value: unknown): value is Eta {
  return isRecord(value) && typeof value.id === 'string' && typeof value.vehicle_id === 'string' && typeof value.stop_id === 'string' && typeof value.minutes === 'number'
}

function isIncident(value: unknown): value is Incident {
  return isRecord(value) && typeof value.id === 'string' && typeof value.route_id === 'string' && typeof value.status === 'string' && typeof value.message === 'string'
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function isTransitState(value: unknown): value is TransitState {
  return isRecord(value)
    && Array.isArray(value.stops) && value.stops.every(isStop)
    && Array.isArray(value.routes) && value.routes.every(isRoute)
    && Array.isArray(value.trips) && value.trips.every(isTrip)
    && Array.isArray(value.vehicles) && value.vehicles.every(isVehicle)
    && Array.isArray(value.etas) && value.etas.every(isEta)
    && Array.isArray(value.incidents) && value.incidents.every(isIncident)
}

function isConnectionAck(value: unknown): value is ConnectionAck {
  return isRecord(value) && value.type === 'connection.ack' && value.protocol === 'transit-demo.v1' && isTransitState(value.state)
}

function isTransitUpdate(value: unknown): value is TransitUpdate {
  return isRecord(value)
    && value.type === 'transit.update'
    && typeof value.event_id === 'string'
    && typeof value.vehicle_id === 'string'
    && typeof value.eta_minutes === 'number'
    && typeof value.position === 'string'
    && typeof value.occurred_at === 'string'
    && typeof value.state_version === 'number'
}

function isTransitReset(value: unknown): value is TransitReset {
  return isRecord(value)
    && value.type === 'transit.reset'
    && isTransitState(value.state)
    && typeof value.occurred_at === 'string'
    && typeof value.state_version === 'number'
}

function isTransitError(value: unknown): value is TransitError {
  return isRecord(value) && value.type === 'error' && typeof value.code === 'string' && typeof value.message === 'string'
}

function isTranscriptionResult(value: unknown): value is TranscriptionResultMessage {
  return isRecord(value)
    && value.type === 'transcription.result'
    && typeof value.id === 'string'
    && typeof value.session_id === 'string'
    && typeof value.text === 'string'
    && Boolean(value.text.trim())
    && isUtcTimestamp(value.created_at)
    && (value.provider === 'live' || value.provider === 'mock')
}

function isTranscriptionSessionStarted(value: unknown): value is TranscriptionSessionStartedMessage {
  return isRecord(value)
    && value.type === 'transcription.session.started'
    && typeof value.session_id === 'string'
    && value.source === 'conversation_microphone'
    && (value.provider === 'cloud' || value.provider === 'mock')
    && (value.mode === 'live' || value.mode === 'mock')
}

function isTranscriptionError(value: unknown): value is TranscriptionErrorMessage {
  return isRecord(value)
    && value.type === 'transcription.session.error'
    && (value.session_id === undefined || typeof value.session_id === 'string')
    && typeof value.code === 'string'
    && typeof value.message === 'string'
}

function isVehicleApproachingNotification(value: unknown): value is VehicleApproachingNotification {
  return isRecord(value)
    && value.type === 'notification.vehicle_approaching'
    && typeof value.event_id === 'string'
    && isUtcTimestamp(value.occurred_at)
    && typeof value.vehicle_id === 'string'
    && typeof value.stop_id === 'string'
    && typeof value.eta_minutes === 'number'
}

function isDestinationApproachingNotification(value: unknown): value is DestinationApproachingNotification {
  return isRecord(value)
    && value.type === 'notification.destination_approaching'
    && typeof value.event_id === 'string'
    && isUtcTimestamp(value.occurred_at)
    && typeof value.vehicle_id === 'string'
    && typeof value.stop_id === 'string'
    && typeof value.eta_minutes === 'number'
}

function isIncidentNotification(value: unknown): value is IncidentNotification {
  return isRecord(value)
    && value.type === 'notification.incident'
    && typeof value.event_id === 'string'
    && isUtcTimestamp(value.occurred_at)
    && typeof value.incident_id === 'string'
    && typeof value.status === 'string'
    && typeof value.cause === 'string'
    && typeof value.action === 'string'
    && typeof value.instruction === 'string'
    && isUtcTimestamp(value.updated_at)
}

function isOffRouteNotification(value: unknown): value is OffRouteNotification {
  return isRecord(value)
    && value.type === 'journey.off_route'
    && typeof value.event_id === 'string'
    && isUtcTimestamp(value.occurred_at)
    && (!('status' in value) || value.status === 'warning' || value.status === 'resolved')
    && typeof value.message === 'string'
}

function parseTransitMessage(value: unknown): TransitMessageWithNotifications | null {
  if (isConnectionAck(value) || isTransitUpdate(value) || isTransitReset(value) || isTransitError(value) || isTranscriptionResult(value) || isTranscriptionSessionStarted(value) || isTranscriptionError(value) || isVehicleApproachingNotification(value) || isDestinationApproachingNotification(value) || isIncidentNotification(value) || isOffRouteNotification(value)) {
    return value
  }

  return null
}

function parseTranscriptRecord(value: unknown): TranscriptRecord | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.payload)) {
    return null
  }

  const payload = value.payload
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  const createdAt = typeof value.created_at === 'string' ? value.created_at : typeof payload.created_at === 'string' ? payload.created_at : ''
  if (!text || !isUtcTimestamp(createdAt)) {
    return null
  }

  return {
    id: value.id,
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : 'history-session',
    text,
    createdAt,
    provider: payload.provider === 'live' ? 'live' : 'mock',
    pinned: value.pinned === true,
    simulated: payload.simulated !== false,
  }
}

function toWebSocketUrl(baseUrl: string): string {
  const parsedUrl = new URL(baseUrl)
  const protocol = parsedUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${parsedUrl.host}/api/ws`
}

function createIncidentRecord(incident: Incident, simulated = true): IncidentRecord {
  return {
    id: incident.id,
    routeId: incident.route_id,
    status: incident.status,
    cause: incident.cause || incident.message,
    action: incident.action || 'Pantau pembaruan visual pada aplikasi.',
    instruction: incident.instruction || 'Ikuti arahan petugas di halte.',
    updatedAt: incident.updated_at || new Date().toISOString(),
    pinned: false,
    simulated,
  }
}

function parseStoredIncident(value: unknown): IncidentRecord | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.payload)) return null
  const payload = value.payload
  if (typeof payload.route_id !== 'string' || typeof payload.status !== 'string') return null
  return {
    id: value.id,
    routeId: payload.route_id,
    status: payload.status,
    cause: typeof payload.cause === 'string' ? payload.cause : 'Pembaruan insiden simulasi.',
    action: typeof payload.action === 'string' ? payload.action : 'Pantau pembaruan visual pada aplikasi.',
    instruction: typeof payload.instruction === 'string' ? payload.instruction : 'Ikuti arahan petugas di halte.',
    updatedAt: typeof payload.updated_at === 'string' ? payload.updated_at : new Date().toISOString(),
    pinned: value.pinned === true,
    simulated: payload.simulated !== false,
  }
}

function notificationTitle(kind: NotificationKind): string {
  if (kind === 'vehicle_approaching') return 'Armada mendekat'
  if (kind === 'destination_approaching') return 'Halte tujuan mendekat'
  if (kind === 'incident') return 'Pembaruan insiden'
  return 'Simulasi keluar rute'
}

function createLocalNotification(kind: Exclude<NotificationKind, 'off_route'>, state: TransitState): NotificationRecord {
  const vehicle = state.vehicles[0]
  const route = state.routes[0]
  const destination = route ? state.stops.find((stop) => stop.id === route.stop_ids[route.stop_ids.length - 1]) : undefined
  const occurredAt = new Date().toISOString()
  if (kind === 'vehicle_approaching') {
    return {
      id: `local-vehicle-${occurredAt}`,
      kind,
      title: notificationTitle(kind),
      message: `Armada ${vehicle?.id || 'seeded'} menuju halte asal. Siap bersiap naik.`,
      occurredAt,
    }
  }
  if (kind === 'destination_approaching') {
    return {
      id: `local-destination-${occurredAt}`,
      kind,
      title: notificationTitle(kind),
      message: `Sebentar lagi tiba di ${destination?.name || 'halte tujuan'}.`,
      occurredAt,
    }
  }

  const incident = state.incidents[0] || SEEDED_TRANSIT_STATE.incidents[0]
  const incidentRecord = createIncidentRecord(incident)
  return {
    id: `local-incident-${occurredAt}`,
    kind,
    title: notificationTitle(kind),
    message: 'Pembaruan simulasi gangguan layanan tersedia.',
    occurredAt,
    incident: { ...incidentRecord, id: `local-${incidentRecord.id}`, status: 'waspada' },
  }
}

function useBackendConnection(): BackendConnection {
  const socketRef = useRef<WebSocket | null>(null)
  const activeTranscriptionSessionRef = useRef<string | null>(null)
  const mockSequenceRef = useRef(0)
  const mockTimerRef = useRef<number | undefined>(undefined)
  const [connection, setConnection] = useState<ConnectionState>({
    status: 'connecting',
    detail: `Mencari backend di ${apiBaseUrl}`,
    attempts: 0,
  })
  const [transitState, setTransitState] = useState<TransitState | null>(() => cloneTransitState(SEEDED_TRANSIT_STATE))
  const [simulationDetail, setSimulationDetail] = useState('Menampilkan seed lokal sampai backend demo terhubung.')
  const [notifications, setNotifications] = useState<NotificationRecord[]>([])
  const [incidentRecords, setIncidentRecords] = useState<IncidentRecord[]>(() => SEEDED_TRANSIT_STATE.incidents.map((incident) => createIncidentRecord(incident)))
  const [microphone, setMicrophone] = useState<MicrophonePermission>('unknown')
  const [transcriptionSession, setTranscriptionSession] = useState<TranscriptionSessionState>({
    status: 'idle',
    source: 'degraded',
    sessionId: null,
    detail: 'Belum ada sesi. Mulai untuk memeriksa akses mikrofon percakapan.',
  })
  const [currentTranscript, setCurrentTranscript] = useState<TranscriptRecord | null>(null)
  const [transcriptHistory, setTranscriptHistory] = useState<TranscriptRecord[]>([])
  const [historyDetail, setHistoryDetail] = useState('Memeriksa history transkrip dari backend…')

  const acceptTranscript = (record: TranscriptRecord) => {
    setCurrentTranscript(record)
    setTranscriptHistory((current) => [record, ...current.filter((candidate) => candidate.id !== record.id)])
    setTranscriptionSession((current) => ({
      ...current,
      status: 'active',
      source: record.provider,
      detail: record.provider === 'live'
        ? 'Hasil live diterima dari backend transcription boundary.'
        : 'Hasil mock demo aktif. Ini bukan transkripsi Cloud STT live.',
    }))
  }

  const activateMockFallback = (detail: string) => {
    const sessionId = activeTranscriptionSessionRef.current
    if (!sessionId) return
    if (mockTimerRef.current !== undefined) {
      window.clearTimeout(mockTimerRef.current)
    }
    setTranscriptionSession((current) => ({ ...current, status: 'active', source: 'mock', sessionId, detail: `${detail} Mock demo digunakan; bukan Cloud STT live.` }))
    const mockText = [
      'Halo, saya ingin bertanya tentang arah perjalanan.',
      'Silakan lihat informasi visual di Transense; saya akan membantu menjelaskan percakapan ini.',
      'Terima kasih, saya sudah memahami informasinya.',
    ][mockSequenceRef.current % 3]
    mockSequenceRef.current += 1
    mockTimerRef.current = window.setTimeout(() => {
      const occurredAt = new Date().toISOString()
      acceptTranscript({
        id: `mock-transcript-${sessionId}-${mockSequenceRef.current}`,
        sessionId,
        text: mockText,
        createdAt: occurredAt,
        provider: 'mock',
        pinned: false,
        simulated: true,
      })
      mockTimerRef.current = undefined
    }, 400)
  }

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${apiBaseUrl}/api/transcripts`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<{ records?: unknown[]; retention_days?: number }>
      })
      .then((payload) => {
        const records = Array.isArray(payload.records) ? payload.records.flatMap((record) => {
          const parsed = parseTranscriptRecord(record)
          return parsed ? [parsed] : []
        }) : []
        setTranscriptHistory(records)
        setHistoryDetail(`History backend aktif · retensi ${payload.retention_days || 7} hari.`)
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setHistoryDetail('History backend belum tersedia; hasil mock hanya terlihat pada sesi demo ini.')
        console.warn('Transense could not load persisted transcript history.', error)
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${apiBaseUrl}/api/incidents`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<{ records?: unknown[] }>
      })
      .then((payload) => {
        const records = Array.isArray(payload.records) ? payload.records.flatMap((record) => {
          const parsed = parseStoredIncident(record)
          return parsed ? [parsed] : []
        }) : []
        if (records.length) setIncidentRecords(records)
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        console.warn('Transense could not load persisted incident history.', error)
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    let socket: WebSocket | null = null
    let reconnectTimer: number | undefined
    let disposed = false
    let attempts = 0

    const scheduleReconnect = () => {
      if (disposed) {
        return
      }

      attempts += 1
      const delay = Math.min(15000, 1000 * 2 ** Math.min(attempts - 1, 4))
      setConnection({
        status: 'reconnecting',
        detail: `Mencoba lagi dalam ${Math.round(delay / 1000)} detik.`,
        attempts,
      })
      reconnectTimer = window.setTimeout(connect, delay)
    }

    const connect = () => {
      if (disposed) {
        return
      }

      setConnection({
        status: attempts === 0 ? 'connecting' : 'reconnecting',
        detail: attempts === 0 ? `Mencari backend di ${apiBaseUrl}` : 'Menyambungkan kembali dengan aman.',
        attempts,
      })

      try {
        socket = new WebSocket(toWebSocketUrl(apiBaseUrl))
        socketRef.current = socket
        socket.addEventListener('open', () => {
          attempts = 0
          setConnection({
            status: 'connected',
            detail: 'WebSocket aktif. Status demo dapat diperbarui.',
            attempts: 0,
          })
        })
        socket.addEventListener('message', (event) => {
          if (typeof event.data !== 'string') {
            setSimulationDetail('Backend mengirim pesan yang tidak dapat dibaca oleh demo shell.')
            return
          }

          try {
            const parsedMessage: unknown = JSON.parse(event.data)
            const message = parseTransitMessage(parsedMessage)
            if (!message) {
              setSimulationDetail('Backend mengirim pesan di luar kontrak transit-demo.v1.')
              return
            }

            if (message.type === 'transcription.session.started') {
              if (activeTranscriptionSessionRef.current === message.session_id) {
                if (message.mode === 'mock') {
                  activateMockFallback('Cloud STT belum dikonfigurasi.')
                } else {
                  setTranscriptionSession((current) => ({ ...current, status: 'active', source: 'live', sessionId: message.session_id, detail: 'Sesi live aktif melalui backend transcription boundary.' }))
                }
              }
            } else if (message.type === 'transcription.result') {
              if (activeTranscriptionSessionRef.current === message.session_id) {
                acceptTranscript({
                  id: message.id,
                  sessionId: message.session_id,
                  text: message.text.trim(),
                  createdAt: message.created_at,
                  provider: message.provider,
                  pinned: false,
                  simulated: message.provider === 'mock',
                })
              }
            } else if (message.type === 'transcription.session.error') {
              if (!message.session_id || message.session_id === activeTranscriptionSessionRef.current) {
                activateMockFallback(`Provider transcription gagal (${message.code}).`)
              }
            } else if (message.type === 'connection.ack') {
              setTransitState(cloneTransitState(message.state))
              setIncidentRecords(message.state.incidents.map((incident) => createIncidentRecord(incident)))
              setSimulationDetail('Seed route context diterima dari backend demo.')
            } else if (message.type === 'transit.update') {
              setTransitState((currentState) => {
                if (!currentState) {
                  return currentState
                }

                return {
                  ...currentState,
                  vehicles: currentState.vehicles.map((vehicle) => vehicle.id === message.vehicle_id
                    ? { ...vehicle, eta_minutes: message.eta_minutes, position: message.position }
                    : vehicle),
                  etas: currentState.etas.map((eta) => eta.vehicle_id === message.vehicle_id
                    ? { ...eta, minutes: message.eta_minutes }
                    : eta),
                }
              })
              setSimulationDetail(`Simulasi memperbarui ${message.vehicle_id}: ETA menjadi ${message.eta_minutes} menit.`)
            } else if (message.type === 'transit.reset') {
              setTransitState(cloneTransitState(message.state))
              setIncidentRecords(message.state.incidents.map((incident) => createIncidentRecord(incident)))
              setNotifications([])
              setSimulationDetail('Seed state dipulihkan dari backend demo.')
            } else if (message.type === 'notification.vehicle_approaching') {
              const notification: NotificationRecord = {
                id: message.event_id,
                kind: 'vehicle_approaching',
                title: notificationTitle('vehicle_approaching'),
                message: message.message || `Armada ${message.vehicle_id} mendekati halte.`,
                occurredAt: message.occurred_at,
              }
              setNotifications((current) => [notification, ...current].slice(0, 8))
              setSimulationDetail('Notifikasi armada mendekat diterima dari WebSocket.')
            } else if (message.type === 'notification.destination_approaching') {
              const notification: NotificationRecord = {
                id: message.event_id,
                kind: 'destination_approaching',
                title: notificationTitle('destination_approaching'),
                message: message.message || 'Halte tujuan segera tiba.',
                occurredAt: message.occurred_at,
              }
              setNotifications((current) => [notification, ...current].slice(0, 8))
              setSimulationDetail('Notifikasi halte tujuan mendekat diterima dari WebSocket.')
            } else if (message.type === 'notification.incident') {
              const incidentRecord: IncidentRecord = {
                id: `${message.incident_id}-${message.event_id}`,
                routeId: message.route_id || 'route-unknown',
                status: message.status,
                cause: message.cause,
                action: message.action,
                instruction: message.instruction,
                updatedAt: message.updated_at,
                pinned: false,
                simulated: true,
              }
              setIncidentRecords((current) => [incidentRecord, ...current.filter((incident) => incident.id !== incidentRecord.id)])
              const notification: NotificationRecord = {
                id: message.event_id,
                kind: 'incident',
                title: notificationTitle('incident'),
                message: message.message || `${message.status}: pembaruan insiden tersedia.`,
                occurredAt: message.occurred_at,
                incident: incidentRecord,
              }
              setNotifications((current) => [notification, ...current].slice(0, 8))
              setSimulationDetail('Pembaruan insiden simulasi diterima dari WebSocket.')
            } else if (message.type === 'journey.off_route') {
              const notification: NotificationRecord = {
                id: message.event_id,
                kind: 'off_route',
                title: notificationTitle('off_route'),
                message: message.message,
                occurredAt: message.occurred_at,
                offRouteStatus: message.status || 'warning',
              }
              setNotifications((current) => [notification, ...current].slice(0, 8))
              setSimulationDetail('Peringatan keluar rute simulasi diterima dari WebSocket.')
            } else {
              if (activeTranscriptionSessionRef.current) {
                activateMockFallback(`Backend menolak sesi transcription (${message.code}).`)
              }
              setSimulationDetail(`Simulasi ditolak: ${message.message}`)
            }
          } catch (error: unknown) {
            setSimulationDetail('Pesan backend tidak dapat diproses oleh demo shell.')
            console.warn('Transense received an invalid WebSocket message.', error)
          }
        })
        socket.addEventListener('error', () => {
          setConnection({
            status: 'offline',
            detail: 'Backend belum tersedia. Shell tetap dapat digunakan.',
            attempts,
          })
          if (activeTranscriptionSessionRef.current) {
            activateMockFallback('Koneksi transcription terputus.')
          }
        })
        socket.addEventListener('close', () => {
          if (socketRef.current === socket) {
            socketRef.current = null
          }
          if (!disposed) {
            if (activeTranscriptionSessionRef.current) {
              activateMockFallback('Backend transcription sedang offline.')
            }
            scheduleReconnect()
          }
        })
      } catch (error: unknown) {
        setConnection({
          status: 'offline',
          detail: 'Alamat backend tidak dapat dibuka. Periksa VITE_API_BASE_URL.',
          attempts,
        })
        console.warn('Transense could not create a WebSocket connection.', error)
        scheduleReconnect()
      }
    }

    connect()

    return () => {
      disposed = true
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer)
      }
      socket?.close()
      socketRef.current = null
    }
  }, [])

  const sendTransitMessage = (message: { type: 'transit.update'; vehicle_id: string } | { type: 'transit.reset' } | { type: 'incident.update'; route_id: string; stage: number }) => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setConnection((current) => ({
        ...current,
        status: 'offline',
        detail: 'Backend belum tersedia. Shell tetap dapat digunakan.',
      }))
      if (message.type === 'incident.update') {
        const localNotification = createLocalNotification('incident', transitState || SEEDED_TRANSIT_STATE)
        setNotifications((current) => [localNotification, ...current].slice(0, 8))
        if (localNotification.incident) setIncidentRecords((current) => [localNotification.incident as IncidentRecord, ...current])
        setSimulationDetail('Uji pembaruan insiden lokal aktif; backend belum tersedia.')
      } else if (message.type === 'transit.reset') {
        setTransitState(cloneTransitState(SEEDED_TRANSIT_STATE))
        setIncidentRecords(SEEDED_TRANSIT_STATE.incidents.map((incident) => createIncidentRecord(incident)))
        setNotifications([])
        setSimulationDetail('Seed lokal dipulihkan; backend belum tersedia.')
      } else {
        setTransitState((current) => {
          if (!current) return current
          return {
            ...current,
            vehicles: current.vehicles.map((vehicle) => vehicle.id === message.vehicle_id
              ? { ...vehicle, eta_minutes: Math.max(0, vehicle.eta_minutes - 1) }
              : vehicle),
            etas: current.etas.map((eta) => eta.vehicle_id === message.vehicle_id
              ? { ...eta, minutes: Math.max(0, eta.minutes - 1) }
              : eta),
          }
        })
        setSimulationDetail('Seed lokal maju satu menit; backend belum tersedia.')
      }
      return
    }

    socket.send(JSON.stringify(message))
  }

  const startTranscription = async () => {
    if (transcriptionSession.status === 'requesting' || transcriptionSession.status === 'active') return
    setTranscriptionSession({
      status: 'requesting',
      source: 'degraded',
      sessionId: null,
      detail: 'Meminta akses mikrofon untuk percakapan langsung…',
    })

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      setMicrophone('unsupported')
      setTranscriptionSession({ status: 'denied', source: 'degraded', sessionId: null, detail: 'Browser ini tidak menyediakan akses mikrofon. Transcription belum aktif.' })
      return
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (error: unknown) {
      setMicrophone('denied')
      const detail = error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Akses mikrofon ditolak. Izinkan mikrofon Android untuk memulai percakapan.'
        : 'Mikrofon tidak dapat diakses. Transcription belum aktif.'
      setTranscriptionSession({ status: 'denied', source: 'degraded', sessionId: null, detail })
      return
    }

    stream.getTracks().forEach((track) => track.stop())
    setMicrophone('granted')
    const sessionId = `transcription-session-${Date.now()}`
    activeTranscriptionSessionRef.current = sessionId
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      activateMockFallback('Backend belum tersedia.')
      return
    }

    setTranscriptionSession({
      status: 'active',
      source: 'degraded',
      sessionId,
      detail: 'Sesi percakapan aktif. Menunggu hasil backend; output audio-only tidak digunakan.',
    })
    socket.send(JSON.stringify({
      type: 'transcription.session.start',
      session_id: sessionId,
      source: 'conversation_microphone',
    }))
  }

  const stopTranscription = () => {
    const sessionId = activeTranscriptionSessionRef.current
    if (!sessionId) {
      setTranscriptionSession((current) => ({ ...current, status: 'idle', detail: 'Tidak ada sesi transcription yang aktif.' }))
      return
    }

    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'transcription.session.stop', session_id: sessionId }))
    }
    if (mockTimerRef.current !== undefined) {
      window.clearTimeout(mockTimerRef.current)
      mockTimerRef.current = undefined
    }
    activeTranscriptionSessionRef.current = null
    setTranscriptionSession((current) => ({ ...current, status: 'idle', source: current.source, sessionId: null, detail: 'Sesi berhenti. Teks fungsional tetap terlihat di history sesi ini.' }))
  }

  const pinTranscript = (transcriptId: string) => {
    const current = transcriptHistory.find((transcript) => transcript.id === transcriptId)
    if (!current) return
    const pinned = !current.pinned
    fetch(`${apiBaseUrl}/api/transcripts/${encodeURIComponent(transcriptId)}/pin`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned }),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        setTranscriptHistory((records) => records.map((record) => record.id === transcriptId ? { ...record, pinned } : record))
        setCurrentTranscript((record) => record?.id === transcriptId ? { ...record, pinned } : record)
        setHistoryDetail(pinned ? 'Transkrip disimpan di backend dan dikecualikan dari cleanup 7 hari.' : 'Marker simpan dilepas; transkrip mengikuti cleanup 7 hari berikutnya.')
      })
      .catch((error: unknown) => {
        setTranscriptHistory((records) => records.map((record) => record.id === transcriptId ? { ...record, pinned } : record))
        setCurrentTranscript((record) => record?.id === transcriptId ? { ...record, pinned } : record)
        setHistoryDetail('Backend history belum tersedia; marker hanya berlaku selama sesi demo ini.')
        console.warn('Transense could not update transcript pin state.', error)
      })
  }

  const saveTranscript = (text: string) => {
    const sessionId = `scribe-${Date.now()}`
    activeTranscriptionSessionRef.current = sessionId
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'transcription.save', text, session_id: sessionId }))
      setSimulationDetail('Transkrip disimpan ke backend.')
    } else {
      acceptTranscript({
        id: `local-scribe-${sessionId}`,
        sessionId,
        text,
        createdAt: new Date().toISOString(),
        provider: 'live',
        pinned: false,
        simulated: false,
      })
      setSimulationDetail('Transkrip disimpan lokal; backend belum tersedia.')
    }
  }

  return {
    connection,
    transitState,
    simulationDetail,
    notifications,
    incidentRecords,
    transcription: {
      microphone,
      session: transcriptionSession,
      current: currentTranscript,
      history: transcriptHistory,
      historyDetail,
      start: () => { void startTranscription() },
      stop: stopTranscription,
      pin: pinTranscript,
      saveTranscript,
    },
    updateTransit: () => sendTransitMessage({ type: 'transit.update', vehicle_id: 'vehicle-kp-01' }),
    resetTransit: () => sendTransitMessage({ type: 'transit.reset' }),
    simulateNotification: (kind) => {
      if (kind === 'incident' && socketRef.current?.readyState === WebSocket.OPEN) {
        sendTransitMessage({ type: 'incident.update', route_id: 'route-1', stage: 0 })
        return
      }
      const localNotification = createLocalNotification(kind, transitState || SEEDED_TRANSIT_STATE)
      setNotifications((current) => [localNotification, ...current].slice(0, 8))
      if (localNotification.incident) {
        setIncidentRecords((current) => [localNotification.incident as IncidentRecord, ...current])
      }
      setSimulationDetail(`Uji ${notificationTitle(kind).toLocaleLowerCase('id-ID')} lokal aktif.`)
    },
    pinIncident: (incidentId) => {
      const current = incidentRecords.find((incident) => incident.id === incidentId)
      if (!current) return
      const pinned = !current.pinned
      fetch(`${apiBaseUrl}/api/incidents/${encodeURIComponent(incidentId)}/pin`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned }),
      })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          setIncidentRecords((records) => records.map((incident) => incident.id === incidentId ? { ...incident, pinned } : incident))
        })
        .catch((error: unknown) => console.warn('Transense could not update incident pin state.', error))
    },
    saveTranscript,
  }
}

function NotificationRenderer({ notification, onDismiss }: { notification: NotificationRecord | null; onDismiss: () => void }) {
  const [flashVisible, setFlashVisible] = useState(false)

  useEffect(() => {
    if (!notification) {
      setFlashVisible(false)
      return
    }

    setFlashVisible(true)
    if (notification.kind === 'vehicle_approaching' && 'vibrate' in navigator && typeof navigator.vibrate === 'function') {
      navigator.vibrate(VIBRATION_PATTERNS.vehicleApproaching)
    } else if (notification.kind === 'destination_approaching' && 'vibrate' in navigator && typeof navigator.vibrate === 'function') {
      navigator.vibrate(VIBRATION_PATTERNS.destinationApproaching)
    } else if (notification.kind === 'incident' && 'vibrate' in navigator && typeof navigator.vibrate === 'function') {
      navigator.vibrate(VIBRATION_PATTERNS.incident)
    }

    const expiry = window.setTimeout(onDismiss, 8000)
    return () => window.clearTimeout(expiry)
  }, [notification])

  if (!notification) return null
  const isDanger = notification.kind === 'incident' || notification.kind === 'off_route'
  return (
    <>
      {flashVisible ? <div className={`edge-flash edge-flash--${isDanger ? 'danger' : 'safe'}`} aria-hidden="true" /> : null}
      <section className={`notification-banner notification-banner--${isDanger ? 'danger' : 'safe'}`} role="alert" aria-live="assertive">
        <div>
          <p className="eyebrow">NOTIFIKASI VISUAL / AUDIO-BLIND</p>
          <h2>{notification.title}</h2>
          <p>{notification.message}</p>
          <small>{notification.kind === 'off_route' ? 'Simulasi debug · tanpa geolocation' : 'Teks dan visual adalah kanal utama; getar Android bersifat tambahan.'}</small>
        </div>
        <button className="notification-banner__dismiss" type="button" onClick={onDismiss} aria-label="Tutup notifikasi">Tutup</button>
      </section>
    </>
  )
}

function ConnectionStatusBadge({ connection }: { connection: ConnectionState }) {
  const labelByStatus: Record<ConnectionStatus, string> = {
    connecting: 'MENGHUBUNGKAN',
    connected: 'TERHUBUNG',
    reconnecting: 'MENCOBA LAGI',
    offline: 'BACKEND OFFLINE',
  }

  return (
    <div className={`connection-status connection-status--${connection.status}`} aria-live="polite">
      <span className="connection-status__dot" aria-hidden="true" />
      <span>
        <strong>{labelByStatus[connection.status]}</strong>
        <small>{connection.detail}</small>
      </span>
    </div>
  )
}

function Onboarding({ onComplete }: { onComplete: (displayName: string) => void }) {
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
    onComplete(trimmedName)
  }

  return (
    <main className="onboarding-frame">
      <div className="onboarding-panel">
        <div className="brand-lockup" aria-label="Transense">
          <span className="brand-lockup__mark" aria-hidden="true"><img className="brand-logo-img" src="/logos/Logo-Transense.png" alt="" /></span>
          <span className="brand-lockup__text">TRANSENSE</span>
        </div>
        <p className="eyebrow">DEMO SHELL / ANDROID READY</p>
        <h1>Informasi perjalanan yang terlihat jelas.</h1>
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
          <button className="primary-button" type="submit">Masuk ke Transense <span aria-hidden="true">→</span></button>
        </form>
        <p className="onboarding-note"><span aria-hidden="true">●</span> Tampilan dirancang audio-blind: status selalu terlihat di layar.</p>
      </div>
    </main>
  )
}

function AppHeader({ title }: { title: string }) {
  return (
    <header className="app-header">
      <div className="app-header__title">
        <span className="brand-mark" aria-hidden="true"><img className="brand-logo-img" src="/logos/Logo-Transense.png" alt="" /></span>
        <div>
          <h1>{title}</h1>
        </div>
      </div>
    </header>
  )
}

function SearchEntry() {
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
        <span className="search-form__icon" aria-hidden="true">⌕</span>
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

function BottomSheet({ children }: { children: ReactNode }) {
  const dragStartY = useRef(0)
  const [collapsed, setCollapsed] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [dragDistance, setDragDistance] = useState(0)

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    dragStartY.current = event.clientY
    setDragDistance(0)
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!dragging) return
    const distance = dragStartY.current - event.clientY
    setDragDistance(distance)
  }

  const handlePointerUp = () => {
    if (!dragging) return
    setDragging(false)
    if (dragDistance > 40) {
      setCollapsed(false)
    } else if (dragDistance < -40) {
      setCollapsed(true)
    }
    setDragDistance(0)
  }

  const className = `bottom-sheet${collapsed ? ' bottom-sheet--collapsed' : ' bottom-sheet--expanded'}${dragging ? ' bottom-sheet--dragging' : ''}`
  const inlineStyle = dragging ? { transform: `translateY(${-dragDistance}px)` } : undefined

  return (
    <div className={className} style={inlineStyle}>
      <button
        className="bottom-sheet__handle"
        type="button"
        aria-label={collapsed ? 'Buka panel informasi' : 'Tutup panel informasi'}
        aria-expanded={!collapsed}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={() => setCollapsed((current) => !current)}
      >
        <span className="bottom-sheet__grip" aria-hidden="true" />
      </button>
      <div className="bottom-sheet__content">
        {children}
      </div>
    </div>
  )
}

interface Arrival {
  bus_id: string
  route_code: string
  headsign: string
  eta_minutes: number
  distance_km: number
}

interface ArrivalsStop {
  id: string
  name: string
  lat: number
  lng: number
  type?: string
  platform?: string
}

type GpsStatus = 'idle' | 'locating' | 'located' | 'denied'

function ArrivalsSheet() {
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>('idle')
  const [currentStop, setCurrentStop] = useState<ArrivalsStop | null>(null)
  const [arrivals, setArrivals] = useState<Arrival[]>([])
  const [detail, setDetail] = useState('Mencari halte terdekat…')
  const [manualQuery, setManualQuery] = useState('')
  const [suggestions, setSuggestions] = useState<ArrivalsStop[]>([])
  const [showManual, setShowManual] = useState(false)

  const fetchArrivals = async (params: string) => {
    try {
      const res = await fetch(`${apiBaseUrl}/api/arrivals?${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { arrivals: Arrival[]; stop: ArrivalsStop | null }
      if (data.stop) {
        setCurrentStop(data.stop)
        setDetail(`Halte ${data.stop.name}`)
      }
      setArrivals(data.arrivals ?? [])
      if ((data.arrivals ?? []).length === 0) {
        setDetail(data.stop ? `Tidak ada bus menuju ${data.stop.name} saat ini` : 'Tidak ada bus ditemukan')
      }
    } catch (error) {
      setDetail('Gagal mengambil data kedatangan.')
      console.warn('Arrivals fetch failed.', error)
    }
  }

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setGpsStatus('denied')
      setDetail('GPS tidak tersedia di browser ini. Ketik nama halte untuk melanjutkan.')
      setShowManual(true)
      return
    }
    setGpsStatus('locating')
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGpsStatus('located')
        void fetchArrivals(`lat=${position.coords.latitude}&lng=${position.coords.longitude}`)
      },
      () => {
        setGpsStatus('denied')
        setDetail('GPS tidak aktif atau ditolak. Ketik nama halte tempatmu berada.')
        setShowManual(true)
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    )
  }, [])

  const handleSearch = async (query: string) => {
    setManualQuery(query)
    if (query.trim().length < 2) {
      setSuggestions([])
      return
    }
    try {
      const res = await fetch(`${apiBaseUrl}/api/gtfs/stops/search?q=${encodeURIComponent(query.trim())}`)
      if (!res.ok) return
      const data = await res.json() as { stops: ArrivalsStop[] }
      setSuggestions(data.stops ?? [])
    } catch {
      setSuggestions([])
    }
  }

  const pickStop = (stop: ArrivalsStop) => {
    setManualQuery(stop.name)
    setSuggestions([])
    void fetchArrivals(`stop_id=${encodeURIComponent(stop.id)}`)
  }

  return (
    <section className="arrivals-sheet" aria-labelledby="arrivals-heading">
      <div className="arrivals-sheet__header">
        <div>
          <p className="eyebrow">BUS MENUJU HALTEMU</p>
          <h3 id="arrivals-heading">{currentStop ? currentStop.name : 'Halte terdekat'}</h3>
        </div>
        <span className={`state-badge state-badge--${gpsStatus === 'located' ? 'safe' : gpsStatus === 'locating' ? 'warning' : 'placeholder'}`}>
          {gpsStatus === 'located' ? 'GPS AKTIF' : gpsStatus === 'locating' ? 'MENCARI GPS' : 'GPS MATI'}
        </span>
      </div>

      {gpsStatus === 'denied' || showManual ? (
        <div className="arrivals-sheet__manual">
          <p className="arrivals-sheet__detail" role="status">{detail}</p>
          <div className="search-form arrivals-sheet__search">
            <span className="search-form__icon" aria-hidden="true">⌕</span>
            <input
              value={manualQuery}
              onChange={(event) => { void handleSearch(event.target.value) }}
              placeholder="Ketik nama halte, mis. Petamburan"
            />
          </div>
          {suggestions.length ? (
            <div className="arrivals-sheet__suggestions">
              {suggestions.map((stop) => (
                <button className="arrivals-sheet__suggestion" type="button" key={stop.id} onClick={() => pickStop(stop)}>
                  <span className="arrivals-sheet__suggestion-name">{stop.name}</span>
                  <span className="arrivals-sheet__suggestion-type">{stop.type ?? 'Halte'}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="arrivals-sheet__detail" role="status">{detail}</p>
      )}

      <div className="arrivals-list" aria-live="polite">
        {arrivals.length ? arrivals.map((arrival) => (
          <article className="arrival-card" key={`${arrival.bus_id}-${arrival.eta_minutes}`}>
            <span className="arrival-card__route">{arrival.route_code}</span>
            <div className="arrival-card__body">
              <strong>{arrival.headsign}</strong>
              <span>{arrival.distance_km} km · {arrival.bus_id}</span>
            </div>
            <span className="arrival-card__eta">{arrival.eta_minutes}′</span>
          </article>
        )) : (
          <div className="empty-state"><span className="empty-state__mark" aria-hidden="true">□</span><h3>Belum ada bus</h3><p>{gpsStatus === 'locating' ? 'Sedang mencari halte terdekat…' : 'Cari halte lain atau tunggu update berikutnya.'}</p></div>
        )}
      </div>
    </section>
  )
}

function HomePage({
  displayName,
  transitState,
  notificationCount,
  notifications,
  onNavigate,
  onDismissNotification,
}: {
  displayName: string
  transitState: TransitState | null
  notificationCount: number
  notifications: NotificationRecord[]
  onNavigate: (screen: Exclude<Screen, 'placeholder'>) => void
  onDismissNotification: (notificationId: string) => void
}) {
  const [gtfsStops, setGtfsStops] = useState<Stop[]>(() => transitState?.stops ?? SEEDED_TRANSIT_STATE.stops)
  const [routeShapes, setRouteShapes] = useState<{ id: string; name: string; color: string; coordinates: [number, number][] }[]>([])
  const [allRoutes, setAllRoutes] = useState<{ id: string; name: string; color: string; stop_ids: string[] }[]>([])
  const [routeStopIds, setRouteStopIds] = useState<Record<string, string[]>>({})
  const [selectedRoutes, setSelectedRoutes] = useState<Set<string>>(new Set())
  const [showFilter, setShowFilter] = useState(false)
  const [mapExpanded, setMapExpanded] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [mapMode, setMapMode] = useState<'bus' | 'rail'>('bus')
  const [selectedRailKeys, setSelectedRailKeys] = useState<Set<string>>(new Set())
  const [stopInfo, setStopInfo] = useState<StopPopupData | null>(null)
  const [railLines, setRailLines] = useState<{ operator: string; code: string; name: string; color: string; mode_label: string; segments: [number, number][][] }[]>([])
  const [railStations, setRailStations] = useState<{ id: string; operator: string; code: string; name: string; lat: number; lng: number; lines: string[] }[]>([])
  const [railStationPopup, setRailStationPopup] = useState<RailStationPopupData | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${apiBaseUrl}/api/transit/lines/geometry`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return
        const data = await res.json() as { lines: { operator: string; code: string; name: string; color: string; mode_label: string; segments: [number, number][][] }[] }
        setRailLines(data.lines)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${apiBaseUrl}/api/transit/stations`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return
        const data = await res.json() as { stations: { id: string; operator: string; code: string; name: string; lat: number; lng: number; lines: string[] }[] }
        setRailStations(data.stations)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      const res = await fetch(`${apiBaseUrl}/api/gtfs/routes`, { signal: controller.signal })
      if (!res.ok) return
      const data = await res.json() as { routes: { id: string; name: string; color: string; stop_ids: string[] }[] }
      setAllRoutes(data.routes)
    }
    void load()
    return () => controller.abort()
  }, [])

  const [busPositions, setBusPositions] = useState<{ id: string; route_code: string; lat: number; lng: number; observed_at: string; next_stop?: { name: string } }[]>([])

  useEffect(() => {
    const fetchBuses = () => {
      fetch(`${apiBaseUrl}/api/buses`)
        .then(async (res) => {
          if (!res.ok) return
          const data = await res.json() as { buses: { id: string; route_code: string; lat: number; lng: number; observed_at: string; next_stop?: { name: string } }[] }
          if (data.buses.length) setBusPositions(data.buses)
        })
        .catch(() => {})
    }
    fetchBuses()
    const interval = window.setInterval(fetchBuses, 15_000)
    return () => window.clearInterval(interval)
  }, [])

  const toggleRoute = async (routeName: string) => {
    const route = allRoutes.find((r) => r.name === routeName)
    const willSelect = !selectedRoutes.has(routeName)
    setSelectedRoutes((prev) => {
      const next = new Set(prev)
      if (next.has(routeName)) next.delete(routeName)
      else next.add(routeName)
      return next
    })
    if (willSelect && route) {
      // Lazy-load the route's shape + station stops only once it's checked.
      if (!routeShapes.some((s) => s.name === route.name)) {
        try {
          const shapeRes = await fetch(`${apiBaseUrl}/api/gtfs/route/${encodeURIComponent(route.id)}/shape`)
          if (shapeRes.ok) {
            const shapeData = await shapeRes.json() as { coordinates: [number, number][]; lines?: [number, number][][] }
            const lines = shapeData.lines?.length ? shapeData.lines : (shapeData.coordinates.length ? [shapeData.coordinates] : [])
            const newShapes = lines.filter((coords) => coords.length >= 2).map((coords, i) => ({ id: `${route.id}#${i}`, name: route.name, color: route.color, coordinates: coords }))
            setRouteShapes((prev) => [...prev, ...newShapes])
          }
        } catch { /* skip */ }
      }
      if (!routeStopIds[route.name]) {
        try {
          const stopsRes = await fetch(`${apiBaseUrl}/api/gtfs/route/${encodeURIComponent(route.id)}/stops`)
          if (stopsRes.ok) {
            const stopsData = await stopsRes.json() as { stops: { id: string; name: string; lat: number; lng: number }[] }
            const ids = stopsData.stops.map((s) => s.id)
            setRouteStopIds((prev) => ({ ...prev, [route.name]: ids }))
            setGtfsStops((prev) => {
              const seen = new Set(prev.map((s) => s.id))
              const additions = stopsData.stops.filter((s) => !seen.has(s.id)).map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng }))
              return [...prev, ...additions]
            })
          }
        } catch { /* skip */ }
      }
    }
  }

  const toggleAll = () => {
    if (selectedRoutes.size === allRoutes.length) {
      setSelectedRoutes(new Set())
    } else {
      setSelectedRoutes(new Set(allRoutes.map((r) => r.name)))
      // Lazy-load shapes + stops for all routes when "select all" is tapped.
      void Promise.all(allRoutes.map((route) => {
        return (async () => {
          try {
            const shapeRes = await fetch(`${apiBaseUrl}/api/gtfs/route/${encodeURIComponent(route.id)}/shape`)
            if (shapeRes.ok) {
              const shapeData = await shapeRes.json() as { coordinates: [number, number][]; lines?: [number, number][][] }
              const lines = shapeData.lines?.length ? shapeData.lines : (shapeData.coordinates.length ? [shapeData.coordinates] : [])
              const newShapes = lines.filter((coords) => coords.length >= 2).map((coords, i) => ({ id: `${route.id}#${i}`, name: route.name, color: route.color, coordinates: coords }))
              setRouteShapes((prev) => {
                const seen = new Set(prev.map((s) => s.id))
                return [...prev, ...newShapes.filter((s) => !seen.has(s.id))]
              })
            }
          } catch { /* skip */ }
          try {
            const stopsRes = await fetch(`${apiBaseUrl}/api/gtfs/route/${encodeURIComponent(route.id)}/stops`)
            if (stopsRes.ok) {
              const stopsData = await stopsRes.json() as { stops: { id: string; name: string; lat: number; lng: number }[] }
              const ids = stopsData.stops.map((s) => s.id)
              setRouteStopIds((prev) => ({ ...prev, [route.name]: ids }))
              setGtfsStops((prev) => {
                const seen = new Set(prev.map((s) => s.id))
                const additions = stopsData.stops.filter((s) => !seen.has(s.id)).map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng }))
                return [...prev, ...additions]
              })
            }
          } catch { /* skip */ }
        })()
      }))
    }
  }

  const filteredShapes = selectedRoutes.size === allRoutes.length ? routeShapes : routeShapes.filter((s) => selectedRoutes.has(s.name))
  const filteredBuses = selectedRoutes.size === allRoutes.length ? busPositions : busPositions.filter((b) => selectedRoutes.has(b.route_code))

  // Stops follow the selected routes: no selection -> empty map (lazy-loaded).
  const displayStops = useMemo(() => {
    if (allRoutes.length === 0) return []
    if (selectedRoutes.size === 0) return []
    if (selectedRoutes.size === allRoutes.length) return gtfsStops
    const stopIds = new Set<string>()
    for (const route of allRoutes) {
      if (selectedRoutes.has(route.name)) {
        for (const sid of routeStopIds[route.name] ?? []) stopIds.add(sid)
      }
    }
    return gtfsStops.filter((s) => stopIds.has(s.id))
  }, [gtfsStops, selectedRoutes, allRoutes, routeStopIds])

  // Route short name -> trayek color (used for bus markers and popups).
  const routeColorMap = useMemo(() => {
    return new Map(allRoutes.map((r) => [r.name, r.color]))
  }, [allRoutes])

  const toggleRailLine = (key: string) => {
    setSelectedRailKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const railAllSelected = railLines.length > 0 && selectedRailKeys.size === railLines.length

  const toggleAllRail = () => {
    if (railAllSelected) {
      setSelectedRailKeys(new Set())
    } else {
      setSelectedRailKeys(new Set(railLines.map((l) => `${l.operator}:${l.code}`)))
    }
  }

  const filteredRailLines = useMemo(() => {
    if (mapMode !== 'rail') return []
    if (selectedRailKeys.size === 0) return railLines
    return railLines.filter((l) => selectedRailKeys.has(`${l.operator}:${l.code}`))
  }, [mapMode, railLines, selectedRailKeys])

  const filteredRailStations = useMemo(() => {
    if (mapMode !== 'rail') return []
    if (selectedRailKeys.size === 0) return railStations
    return railStations.filter((s) => s.lines.some((lk) => selectedRailKeys.has(lk)))
  }, [mapMode, railStations, selectedRailKeys])

  const handleStopClick = async (stopId: string) => {
    try {
      const res = await fetch(`${apiBaseUrl}/api/gtfs/stop/${encodeURIComponent(stopId)}/info`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as StopPopupData
      setStopInfo(data)
    } catch (error) {
      console.warn('Stop info fetch failed.', error)
      setStopInfo(null)
    }
  }

  const handleRailStationClick = async (stationId: string) => {
    const station = railStations.find((s) => s.id === stationId)
    if (!station) return
    try {
      const res = await fetch(`${apiBaseUrl}/api/transit/stop/${encodeURIComponent(station.operator)}/${encodeURIComponent(station.code)}/info`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { stop: { id: string; name: string; operator: string; official_name?: string; amenities?: { type: string; label: string; text: string }[] } }
      setRailStationPopup({
        stop: {
          id: data.stop.id,
          name: data.stop.name,
          operator: data.stop.operator,
          official_name: data.stop.official_name,
          amenities: data.stop.amenities,
          lng: station.lng,
          lat: station.lat,
        },
      })
    } catch (error) {
      console.warn('Rail station info fetch failed.', error)
      setRailStationPopup(null)
    }
  }

  return (
    <main className="page-content home-page">
      <header className={`home-topbar${mapExpanded ? ' home-topbar--minimized' : ''}`}>
        <div>
          <p className="eyebrow">SELAMAT DATANG KEMBALI</p>
          <h2 id="welcome-heading">Halo, {displayName}!</h2>
        </div>
        <button
          type="button"
          className="notification-btn"
          aria-label="Buka daftar notifikasi"
          aria-expanded={notificationsOpen}
          aria-controls="notification-panel"
          onClick={() => setNotificationsOpen((open) => !open)}
        >
          <BellIcon />
          {notificationCount > 0 ? <span className="notification-btn__badge" data-count={notificationCount}>{notificationCount}</span> : null}
        </button>
      </header>
      {notificationsOpen ? (
        <section className="notification-panel" id="notification-panel" aria-label="Daftar notifikasi">
          <p className="eyebrow">NOTIFIKASI AKTIF</p>
          {notifications.length === 0 ? (
            <p className="notification-panel__empty" role="status">Tidak ada notifikasi aktif.</p>
          ) : (
            <ul className="notification-panel__list">
              {notifications.map((notification) => (
                <li key={notification.id}>
                  <article className="notification-banner notification-banner--safe">
                    <div>
                      <strong>{notification.title}</strong>
                      <span>{notification.message}</span>
                    </div>
                    <button className="notification-banner__dismiss" type="button" onClick={() => onDismissNotification(notification.id)} aria-label={`Tutup notifikasi ${notification.title}`}>Tutup</button>
                  </article>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      <SearchEntry />
      <section id="home-hero" className={`home-hero${mapExpanded ? ' home-hero--maximized' : ' home-hero--minimized'}`}>
        <div className="home-hero__map">
          <button className={`map-filter-btn${showFilter ? ' map-filter-btn--active' : ''}`} type="button" onClick={() => setShowFilter((v) => !v)}>
            Filter Rute ({selectedRoutes.size})
          </button>
          {showFilter ? (
            <div className="map-filter-panel">
              <div className="map-filter-panel__header">
                <strong>Filter peta</strong>
                <button className="secondary-button" type="button" onClick={mapMode === 'bus' ? toggleAll : toggleAllRail}>
                  {mapMode === 'bus'
                    ? (selectedRoutes.size === allRoutes.length ? 'Hapus semua' : 'Pilih semua')
                    : (railAllSelected ? 'Hapus semua' : 'Pilih semua')}
                </button>
              </div>
              <div className="map-filter-modes" role="group" aria-label="Filter moda">
                <label className="map-filter-mode">
                  <input type="radio" name="map-mode" checked={mapMode === 'bus'} onChange={() => setMapMode('bus')} />
                  <span className="map-filter-mode__tag">Bus</span>
                </label>
                <label className="map-filter-mode">
                  <input type="radio" name="map-mode" checked={mapMode === 'rail'} onChange={() => setMapMode('rail')} />
                  <span className="map-filter-mode__tag">Kereta</span>
                </label>
              </div>
              {mapMode === 'rail' ? (
                <>
                  <div className="map-filter-panel__line-head">
                    <p className="map-filter-panel__section">LIN KERETA</p>
                  </div>
                  <div className="map-filter-rail-list">
                    {railLines.map((line) => {
                      const key = `${line.operator}:${line.code}`
                      const checked = selectedRailKeys.has(key)
                      return (
                        <label className="map-filter-checkbox" key={key}>
                          <input type="checkbox" checked={checked} onChange={() => toggleRailLine(key)} />
                          <span className="map-filter-checkbox__swatch" style={{ background: line.color }} aria-hidden="true" />
                          <span className="map-filter-checkbox__rail-name">{line.name}</span>
                          <span className="map-filter-checkbox__mode">{line.mode_label}</span>
                        </label>
                      )
                    })}
                  </div>
                </>
              ) : (
                <>
                  <p className="map-filter-panel__section">RUTE BUS</p>
                  <div className="map-filter-panel__list">
                    {allRoutes.map((route) => (
                      <label className="map-filter-checkbox" key={route.id}>
                        <input type="checkbox" checked={selectedRoutes.has(route.name)} onChange={() => toggleRoute(route.name)} />
                        <span className="map-filter-checkbox__swatch" style={{ background: route.color }} aria-hidden="true" />
                        <span>{route.name}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : null}
          <MapboxMap
            stops={mapMode === 'bus' ? displayStops : []}
            routeShapes={mapMode === 'bus' ? filteredShapes : []}
            buses={mapMode === 'bus' ? filteredBuses : []}
            selectedRouteNames={selectedRoutes}
            routeColors={routeColorMap}
            stopPopup={mapMode === 'bus' ? stopInfo : null}
            onStopClick={(id) => { void handleStopClick(id) }}
            onStopPopupClose={() => setStopInfo(null)}
            railLines={filteredRailLines}
            railStations={filteredRailStations}
            railStationPopup={railStationPopup}
            onRailStationClick={(id) => { void handleRailStationClick(id) }}
            onRailStationPopupClose={() => setRailStationPopup(null)}
          />
        </div>
        <button
          type="button"
          className="map-toggle-btn"
          aria-label={mapExpanded ? 'Ciutkan peta' : 'Perbesar peta'}
          aria-expanded={mapExpanded}
          aria-controls="home-hero"
          onClick={() => setMapExpanded((expanded) => !expanded)}
        >
          {mapExpanded ? <MinimizeIcon /> : <MaximizeIcon />}
        </button>
      </section>
      <ul className="feature-list">
        <li>
          <button type="button" className="feature-tile" onClick={() => onNavigate('antar-aku')}>
            <span className="feature-tile__icon"><AntarAkuIcon /></span>
            <span className="feature-tile__label">Antar Aku</span>
          </button>
        </li>
        <li>
          <button type="button" className="feature-tile" onClick={() => onNavigate('transcribe')}>
            <span className="feature-tile__icon"><TranscribeIcon /></span>
            <span className="feature-tile__label">Transcribe</span>
          </button>
        </li>
        <li>
          <button type="button" className="feature-tile" onClick={() => onNavigate('delays')}>
            <span className="feature-tile__icon"><DelaysIcon /></span>
            <span className="feature-tile__label">Keterlambatan</span>
          </button>
        </li>
        <li>
          <button type="button" className="feature-tile" onClick={() => onNavigate('schedule')}>
            <span className="feature-tile__icon"><ScheduleIcon /></span>
            <span className="feature-tile__label">Jadwal Transportasi Umum</span>
          </button>
        </li>
      </ul>
      <BottomSheet>
        <ArrivalsSheet />
      </BottomSheet>
    </main>
  )
}

interface GtfsRouteInfo {
  id: string
  name: string
  long_name: string
  color: string
}

interface GtfsRouteStop {
  id: string
  name: string
}

interface ScheduleStopGroup {
  route_code: string
  color: string
  headsign: string
  direction: string
  platform?: string
  times: string[]
}

interface ScheduleLiveEntry {
  bus_id: string
  route_code: string
  eta_minutes: number
  headsign: string
}

interface ScheduleDetailData {
  stop: { id: string; name: string; operator?: string; wheelchair_boarding?: string }
  timetable: ScheduleStopGroup[]
  live: ScheduleLiveEntry[]
}

interface RailLineInfo {
  operator: string
  operator_name: string
  code: string
  name: string
  color: string
  mode: string
  mode_label: string
}

interface RailStopInfo {
  id: string
  code: string
  name: string
}

function SchedulePage() {
  const [mode, setMode] = useState<'bus' | 'rail'>('bus')
  const [routes, setRoutes] = useState<GtfsRouteInfo[]>([])
  const [railLines, setRailLines] = useState<RailLineInfo[]>([])
  const [query, setQuery] = useState('')
  const [expandedRoute, setExpandedRoute] = useState<string | null>(null)
  const [routeStops, setRouteStops] = useState<Record<string, GtfsRouteStop[]>>({})
  const [loadingStops, setLoadingStops] = useState(false)
  const [selectedStop, setSelectedStop] = useState<{ id: string; name: string } | null>(null)
  const [schedule, setSchedule] = useState<ScheduleDetailData | null>(null)
  const [loadingSchedule, setLoadingSchedule] = useState(false)
  const [searchStops, setSearchStops] = useState<{ id: string; name: string }[]>([])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${apiBaseUrl}/api/gtfs/routes`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return
        const data = await res.json() as { routes: { id: string; name: string; long_name: string; color: string }[] }
        setRoutes(data.routes)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${apiBaseUrl}/api/transit/lines`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return
        const data = await res.json() as { lines: RailLineInfo[] }
        setRailLines(data.lines)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setSearchStops([])
      return
    }
    if (mode !== 'bus') return
    const controller = new AbortController()
    fetch(`${apiBaseUrl}/api/gtfs/stops/search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return
        const data = await res.json() as { stops: { id: string; name: string }[] }
        if (!controller.signal.aborted) setSearchStops(data.stops)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [query, mode])

  const toggleRoute = async (routeId: string) => {
    if (expandedRoute === routeId) {
      setExpandedRoute(null)
      return
    }
    setExpandedRoute(routeId)
    if (routeStops[routeId]) return
    setLoadingStops(true)
    try {
      const res = await fetch(`${apiBaseUrl}/api/gtfs/route/${encodeURIComponent(routeId)}/stops`)
      if (!res.ok) return
      const data = await res.json() as { stops: GtfsRouteStop[] }
      setRouteStops((prev) => ({ ...prev, [routeId]: data.stops }))
    } catch { /* skip */ } finally {
      setLoadingStops(false)
    }
  }

  const toggleRailLine = async (key: string) => {
    if (expandedRoute === key) {
      setExpandedRoute(null)
      return
    }
    setExpandedRoute(key)
    if (routeStops[key]) return
    setLoadingStops(true)
    try {
      const [operator, code] = key.split(':')
      const res = await fetch(`${apiBaseUrl}/api/transit/line/${encodeURIComponent(operator)}/${encodeURIComponent(code)}/stations`)
      if (!res.ok) return
      const data = await res.json() as { stations: RailStopInfo[] }
      const stops: GtfsRouteStop[] = data.stations.map((s) => ({ id: s.id, name: s.name }))
      setRouteStops((prev) => ({ ...prev, [key]: stops }))
    } catch { /* skip */ } finally {
      setLoadingStops(false)
    }
  }

  const openBusStopSchedule = async (stopId: string, stopName: string) => {
    setSelectedStop({ id: stopId, name: stopName })
    setSchedule(null)
    setLoadingSchedule(true)
    try {
      const res = await fetch(`${apiBaseUrl}/api/gtfs/stop/${encodeURIComponent(stopId)}/schedule`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { stop: { id: string; name: string; wheelchair_boarding?: string }; timetable: ScheduleStopGroup[]; live: ScheduleLiveEntry[] }
      setSchedule(data)
    } catch (error) {
      console.warn('Stop schedule fetch failed.', error)
    } finally {
      setLoadingSchedule(false)
    }
  }

  const openRailStopSchedule = async (stationId: string, stationName: string) => {
    setSelectedStop({ id: stationId, name: stationName })
    setSchedule(null)
    setLoadingSchedule(true)
    try {
      const [operator, code] = stationId.split('-')
      const res = await fetch(`${apiBaseUrl}/api/transit/stop/${encodeURIComponent(operator)}/${encodeURIComponent(code)}/schedule`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { stop: { id: string; name: string; operator: string }; timetable: ScheduleStopGroup[] }
      setSchedule({ stop: data.stop, timetable: data.timetable, live: [] })
    } catch (error) {
      console.warn('Rail schedule fetch failed.', error)
    } finally {
      setLoadingSchedule(false)
    }
  }

  const filteredRoutes = useMemo(() => {
    const trimmed = query.trim().toLocaleLowerCase('id-ID')
    if (!trimmed) return routes
    return routes.filter((r) =>
      r.name.toLocaleLowerCase('id-ID').includes(trimmed)
      || r.long_name.toLocaleLowerCase('id-ID').includes(trimmed)
      || r.id.toLocaleLowerCase('id-ID').includes(trimmed)
    )
  }, [routes, query])

  const filteredRailLines = useMemo(() => {
    const trimmed = query.trim().toLocaleLowerCase('id-ID')
    if (!trimmed) return railLines
    return railLines.filter((l) =>
      l.name.toLocaleLowerCase('id-ID').includes(trimmed)
      || l.code.toLocaleLowerCase('id-ID').includes(trimmed)
      || l.mode_label.toLocaleLowerCase('id-ID').includes(trimmed)
    )
  }, [railLines, query])

  const isSearching = query.trim().length > 0

  const detailView = (
    <section className="schedule-detail" aria-label={`Jadwal halte ${selectedStop?.name}`}>
      <div className="schedule-detail__header">
        <button type="button" className="schedule-detail__back" onClick={() => setSelectedStop(null)}>← Kembali</button>
        <button type="button" className="schedule-detail__close" onClick={() => setSelectedStop(null)} aria-label="Tutup jadwal">✕</button>
      </div>
      <div>
        <p className="eyebrow">JADWAL KEDATANGAN</p>
        <h3>{selectedStop?.name}</h3>
      </div>
      {loadingSchedule ? <p className="schedule-routes__loading">Memuat jadwal…</p> : null}
      {schedule && schedule.live.length > 0 ? (
        <div className="schedule-detail__live">
          <p className="eyebrow">LIVE — BUS MENDEKAT</p>
          {schedule.live.map((bus) => (
            <div className="schedule-detail__live-row" key={`${bus.bus_id}-${bus.route_code}`}>
              <span className="schedule-route__badge" style={{ background: schedule.timetable.find((g) => g.route_code === bus.route_code)?.color ?? '#1677ff' }}>{bus.route_code}</span>
              <span className="schedule-detail__live-eta">{bus.eta_minutes} menit</span>
              <span className="schedule-detail__live-headsign">{bus.headsign}</span>
            </div>
          ))}
        </div>
      ) : null}
      {schedule && schedule.timetable.length > 0 ? (
        <div className="schedule-detail__timetable">
          <p className="eyebrow">JADWAL PER RUTE</p>
          {schedule.timetable.map((group, index) => (
            <div className="schedule-detail__group" key={`${group.route_code}-${group.headsign}-${index}`}>
              <div className="schedule-detail__group-head">
                <span className="schedule-route__badge" style={{ background: group.color }}>{group.route_code}</span>
                <span className="schedule-detail__group-headsign">{group.headsign}</span>
                {group.platform ? <span className="schedule-detail__platform">Peron {group.platform}</span> : null}
              </div>
              <div className="schedule-detail__times">
                {group.times.map((time) => <span className="schedule-detail__time" key={time}>{time}</span>)}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {schedule && schedule.timetable.length === 0 && schedule.live.length === 0 && !loadingSchedule ? (
        <p className="schedule-routes__loading">Tidak ada jadwal untuk halte ini.</p>
      ) : null}
    </section>
  )

  if (selectedStop) {
    return (
      <main className="page-content inner-page">
        {detailView}
      </main>
    )
  }

  const railList = (
    <section className="schedule-routes" aria-label="Daftar lin kereta">
      {filteredRailLines.map((line) => {
        const key = `${line.operator}:${line.code}`
        const expanded = expandedRoute === key
        const stops = routeStops[key]
        return (
          <div className="schedule-route" key={key}>
            <button
              type="button"
              className="schedule-route__head"
              aria-expanded={expanded}
              onClick={() => { void toggleRailLine(key) }}
            >
              <span className="schedule-route__badge" style={{ background: line.color }}>{line.code}</span>
              <span className="schedule-route__name">{line.name}</span>
              <span className="schedule-result-tag schedule-result-tag--rail">{line.mode_label}</span>
              <span className="schedule-route__toggle" aria-hidden="true">{expanded ? '−' : '+'}</span>
            </button>
            {expanded ? (
              <div className="schedule-route__stops">
                {stops ? stops.map((stop) => (
                  <button
                    key={stop.id}
                    type="button"
                    className="schedule-stop-row"
                    onClick={() => { void openRailStopSchedule(stop.id, stop.name) }}
                  >
                    <span className="schedule-stop-row__name">{stop.name}</span>
                    <span className="schedule-stop-row__cta">Jadwal →</span>
                  </button>
                )) : loadingStops ? <p className="schedule-routes__loading">Memuat stasiun…</p> : null}
              </div>
            ) : null}
          </div>
        )
      })}
    </section>
  )

  const busList = (
    <section className="schedule-routes" aria-label="Daftar trayek">
      {(isSearching ? filteredRoutes : routes).map((route) => {
        const expanded = expandedRoute === route.id
        const stops = routeStops[route.id]
        return (
          <div className="schedule-route" key={route.id}>
            <button
              type="button"
              className="schedule-route__head"
              aria-expanded={expanded}
              onClick={() => { void toggleRoute(route.id) }}
            >
              <span className="schedule-route__badge" style={{ background: route.color }}>{route.name}</span>
              <span className="schedule-route__name">{route.long_name}</span>
              <span className="schedule-route__toggle" aria-hidden="true">{expanded ? '−' : '+'}</span>
            </button>
            {expanded ? (
              <div className="schedule-route__stops">
                {stops ? stops.map((stop) => (
                  <button
                    key={stop.id}
                    type="button"
                    className="schedule-stop-row"
                    onClick={() => { void openBusStopSchedule(stop.id, stop.name) }}
                  >
                    <span className="schedule-stop-row__name">{stop.name}</span>
                    <span className="schedule-stop-row__cta">Jadwal →</span>
                  </button>
                )) : loadingStops ? <p className="schedule-routes__loading">Memuat halte…</p> : null}
              </div>
            ) : null}
          </div>
        )
      })}
    </section>
  )

  const searchResults = (
    <section className="schedule-search-results" aria-label="Hasil pencarian">
      <p className="eyebrow">HASIL PENCARIAN</p>
      {mode === 'bus' ? (
        <>
          {filteredRoutes.map((route) => {
            const expanded = expandedRoute === route.id
            const stops = routeStops[route.id]
            return (
              <div className="schedule-route" key={`route-${route.id}`}>
                <button
                  type="button"
                  className="schedule-route__head"
                  aria-expanded={expanded}
                  onClick={() => { void toggleRoute(route.id) }}
                >
                  <span className="schedule-route__badge" style={{ background: route.color }}>{route.name}</span>
                  <span className="schedule-route__name">{route.long_name}</span>
                  <span className="schedule-result-tag schedule-result-tag--route">TRAYEK</span>
                  <span className="schedule-route__toggle" aria-hidden="true">{expanded ? '−' : '+'}</span>
                </button>
                {expanded ? (
                  <div className="schedule-route__stops">
                    {stops ? stops.map((stop) => (
                      <button
                        key={stop.id}
                        type="button"
                        className="schedule-stop-row"
                        onClick={() => { void openBusStopSchedule(stop.id, stop.name) }}
                      >
                        <span className="schedule-stop-row__name">{stop.name}</span>
                        <span className="schedule-stop-row__cta">Jadwal →</span>
                      </button>
                    )) : loadingStops ? <p className="schedule-routes__loading">Memuat halte…</p> : null}
                  </div>
                ) : null}
              </div>
            )
          })}
          {searchStops.map((stop) => (
            <button
              key={`stop-${stop.id}`}
              type="button"
              className="schedule-stop-row"
              onClick={() => { void openBusStopSchedule(stop.id, stop.name) }}
            >
              <span className="schedule-result-tag schedule-result-tag--stop">HALTE</span>
              <span className="schedule-stop-row__name">{stop.name}</span>
              <span className="schedule-stop-row__cta">Jadwal →</span>
            </button>
          ))}
          {filteredRoutes.length === 0 && searchStops.length === 0 ? <p className="schedule-routes__loading">Tidak ada halte atau trayek yang cocok.</p> : null}
        </>
      ) : (
        <>
          {filteredRailLines.map((line) => {
            const key = `${line.operator}:${line.code}`
            const expanded = expandedRoute === key
            const stops = routeStops[key]
            return (
              <div className="schedule-route" key={`rail-${key}`}>
                <button
                  type="button"
                  className="schedule-route__head"
                  aria-expanded={expanded}
                  onClick={() => { void toggleRailLine(key) }}
                >
                  <span className="schedule-route__badge" style={{ background: line.color }}>{line.code}</span>
                  <span className="schedule-route__name">{line.name}</span>
                  <span className="schedule-result-tag schedule-result-tag--rail">{line.mode_label}</span>
                  <span className="schedule-route__toggle" aria-hidden="true">{expanded ? '−' : '+'}</span>
                </button>
                {expanded ? (
                  <div className="schedule-route__stops">
                    {stops ? stops.map((stop) => (
                      <button
                        key={stop.id}
                        type="button"
                        className="schedule-stop-row"
                        onClick={() => { void openRailStopSchedule(stop.id, stop.name) }}
                      >
                        <span className="schedule-stop-row__name">{stop.name}</span>
                        <span className="schedule-stop-row__cta">Jadwal →</span>
                      </button>
                    )) : loadingStops ? <p className="schedule-routes__loading">Memuat stasiun…</p> : null}
                  </div>
                ) : null}
              </div>
            )
          })}
          {filteredRailLines.length === 0 ? <p className="schedule-routes__loading">Tidak ada lin yang cocok.</p> : null}
        </>
      )}
    </section>
  )

  return (
    <main className="page-content inner-page">
      <section className="page-intro">
        <p className="eyebrow">JADWAL TRANSJAKARTA & KERETA / GTFS + LIVE</p>
        <h2>Jadwal halte & stasiun</h2>
        <p>Pilih moda, buka trayek/lin, lalu lihat jadwal kedatangan per rute plus ETA live bila tersedia.</p>
      </section>

      <div className="schedule-mode-toggle" role="tablist" aria-label="Pilih moda">
        <button
          type="button"
          className={`schedule-mode-btn${mode === 'bus' ? ' schedule-mode-btn--active' : ''}`}
          onClick={() => { setMode('bus'); setExpandedRoute(null) }}
          aria-selected={mode === 'bus'}
          role="tab"
        >
          Bus
        </button>
        <button
          type="button"
          className={`schedule-mode-btn${mode === 'rail' ? ' schedule-mode-btn--active' : ''}`}
          onClick={() => { setMode('rail'); setExpandedRoute(null) }}
          aria-selected={mode === 'rail'}
          role="tab"
        >
          Kereta
        </button>
      </div>

      <section className="schedule-search" role="search">
        <label className="sr-only" htmlFor="schedule-search">{mode === 'bus' ? 'Cari halte atau trayek' : 'Cari lin kereta'}</label>
        <span className="schedule-search__icon" aria-hidden="true">⌕</span>
        <input
          id="schedule-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={mode === 'bus' ? 'Cari halte atau trayek' : 'Cari lin kereta'}
        />
      </section>

      {isSearching ? searchResults : (mode === 'rail' ? railList : busList)}
    </main>
  )
}

function DelaysPage({ incidentRecords, onPinIncident }: { incidentRecords: IncidentRecord[]; onPinIncident: (incidentId: string) => void }) {
  return (
    <main className="page-content inner-page">
      <section className="page-intro">
        <p className="eyebrow">FEED STATUS / 7 HARI</p>
        <h2>Keterlambatan</h2>
        <p>Riwayat insiden terstruktur yang dapat dibaca ulang. Semua entri adalah simulasi demo, bukan feed resmi live.</p>
      </section>
      {incidentRecords.map((incident) => (
        <article className="incident-card incident-card--warning" key={incident.id}>
          <div className="incident-card__header"><span className="state-badge state-badge--warning">SIMULASI</span><time dateTime={incident.updatedAt}>{new Date(incident.updatedAt).toLocaleString('id-ID')}</time></div>
          <h3>{incident.status}</h3>
          <dl className="incident-details">
            <div><dt>Penyebab</dt><dd>{incident.cause}</dd></div>
            <div><dt>Tindakan</dt><dd>{incident.action}</dd></div>
            <div><dt>Instruksi</dt><dd>{incident.instruction}</dd></div>
          </dl>
          <div className="incident-card__footer">
            <span>{incident.pinned ? 'Tersimpan di sesi demo · marker pin aktif' : 'Retensi demo: 7 hari'}</span>
            <button className="secondary-button" type="button" onClick={() => onPinIncident(incident.id)}>{incident.pinned ? 'Lepas simpan' : 'Simpan / pin'}</button>
          </div>
        </article>
      ))}
    </main>
  )
}

function AntarAkuPage() {
  return <PlannerPage apiBaseUrl={apiBaseUrl} />
}

function ProfilePage({ profile, onReset, connection, simulationDetail }: { profile: DemoProfile; onReset: () => void; connection: ConnectionState; simulationDetail: string }) {
  return (
    <main className="page-content inner-page">
      <section className="page-intro">
        <p className="eyebrow">PROFIL DEMO / PERANGKAT INI</p>
        <h2>Profil</h2>
        <p>Identitas demo tersimpan lokal agar alur pembukaan berikutnya tetap singkat.</p>
      </section>
      <section className="profile-card" aria-labelledby="profile-card-heading">
        <span className="profile-avatar" aria-hidden="true">{profile.displayName.slice(0, 1).toUpperCase()}</span>
        <div>
          <p className="eyebrow">NAMA PANGGILAN</p>
          <h3 id="profile-card-heading">{profile.displayName}</h3>
          <p>Dibuat {new Date(profile.createdAt).toLocaleDateString('id-ID')}</p>
        </div>
      </section>
      <section className="connection-panel" aria-labelledby="connection-panel-heading">
        <div className="section-heading">
          <p className="eyebrow">STATUS KONEKSI</p>
          <h2 id="connection-panel-heading">Koneksi backend</h2>
        </div>
        <div className="connection-panel__badge">
          <ConnectionStatusBadge connection={connection} />
        </div>
        <div className="connection-panel__details">
          <div className="connection-panel__detail"><span>Alamat backend</span><strong>{apiBaseUrl}</strong></div>
          <div className="connection-panel__detail"><span>Percobaan koneksi</span><strong>{connection.attempts}</strong></div>
          <div className="connection-panel__detail"><span>Detail simulasi</span><strong>{simulationDetail}</strong></div>
        </div>
      </section>
      <div className="notice-box"><strong>Catatan privasi demo</strong><span>Tidak ada login produksi atau data cloud di shell ini.</span></div>
      <button className="secondary-button" type="button" onClick={onReset}>Hapus profil demo</button>
    </main>
  )
}

function BottomNavigation({ screen, onNavigate }: { screen: Screen; onNavigate: (screen: Exclude<Screen, 'placeholder'>) => void }) {
  const navigationItems: Array<{ screen: Exclude<Screen, 'placeholder'>; label: string; icon: string }> = [
    { screen: 'home', label: 'Beranda', icon: '⌂' },
    { screen: 'profile', label: 'Profil', icon: '◉' },
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

function MainShell({ profile, onResetProfile }: { profile: DemoProfile; onResetProfile: () => void }) {
  const [screen, setScreen] = useState<Screen>('home')
  const [dismissedNotificationIds, setDismissedNotificationIds] = useState<string[]>([])
  const backend = useBackendConnection()
  const unreadNotifications = backend.notifications.filter((notification) => !dismissedNotificationIds.includes(notification.id))
  const unreadCount = unreadNotifications.length
  const currentNotification = backend.notifications.find((notification) => !dismissedNotificationIds.includes(notification.id)) || null

  const title = useMemo(() => {
    if (screen === 'home') return 'Beranda'
    if (screen === 'delays') return 'Keterlambatan'
    if (screen === 'profile') return 'Profil'
    if (screen === 'schedule') return 'Jadwal Transportasi Umum'
    if (screen === 'antar-aku') return 'Antar Aku'
    if (screen === 'transcribe') return 'Transcribe'
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
      {screen === 'home' ? null : <AppHeader title={title} />}
      <NotificationRenderer notification={currentNotification} onDismiss={() => {
        if (currentNotification) dismissNotification(currentNotification.id)
      }} />
      {screen === 'home' ? <HomePage displayName={profile.displayName} transitState={backend.transitState} notificationCount={unreadCount} notifications={unreadNotifications} onNavigate={handleNavigate} onDismissNotification={dismissNotification} /> : null}
      {screen === 'schedule' ? <SchedulePage /> : null}
      {screen === 'delays' ? <DelaysPage incidentRecords={backend.incidentRecords} onPinIncident={backend.pinIncident} /> : null}
      {screen === 'transcribe' ? <ChatTranscribe apiBaseUrl={apiBaseUrl} /> : null}
      {screen === 'antar-aku' ? <AntarAkuPage /> : null}
      {screen === 'profile' ? <ProfilePage profile={profile} onReset={onResetProfile} connection={backend.connection} simulationDetail={backend.simulationDetail} /> : null}
      <BottomNavigation screen={screen} onNavigate={handleNavigate} />
    </div>
  )
}

function SplashScreen({ leaving }: { leaving: boolean }) {
  return (
    <main className={`splash-screen${leaving ? ' splash-screen--leaving' : ''}`} aria-label="Memuat Transense">
      <div className="splash-screen__stage">
        <img className="splash-screen__logo" src="/logos/Logo-Transense.png" alt="Logo Transense" />
      </div>
      <p className="splash-screen__brand">TRANSENSE</p>
      <p className="splash-screen__tagline">Informasi perjalanan yang terlihat jelas.</p>
    </main>
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

  if (!splashDone) {
    return <SplashScreen leaving={splashLeaving} />
  }

  if (!profile || screen === 'onboarding') {
    return <Onboarding onComplete={handleCompleteOnboarding} />
  }

  return <MainShell profile={profile} onResetProfile={handleResetProfile} />
}
