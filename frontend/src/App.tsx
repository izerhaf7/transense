import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useScribe } from '@elevenlabs/react'
import {
  areVibrationPatternsDistinct,
  cloneTransitState,
  findRouteBetweenStops,
  matchSeededStop,
  SEEDED_TRANSIT_STATE,
  VIBRATION_PATTERNS,
} from './journey'
import type { Eta, Incident, Route, Stop, TransitState, Trip, Vehicle } from './journey'
import MapboxMap from './MapboxMap'

type Screen = 'onboarding' | 'home' | 'delays' | 'profile' | 'schedule' | 'antar-aku' | 'transcribe' | 'placeholder'
type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline'
type NotificationKind = 'vehicle_approaching' | 'destination_approaching' | 'incident' | 'off_route'
type JourneyState = 'entry' | 'matching' | 'route' | 'active' | 'ended'
type MicrophonePermission = 'unknown' | 'granted' | 'denied' | 'unsupported'
type TranscriptionSource = 'live' | 'mock' | 'degraded'

interface DemoProfile {
  displayName: string
  createdAt: string
}

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

interface OptionalStaticData {
  stops: Stop[]
  routes: Route[]
  timetableCount: number
  sourceLabel: string
}

interface JourneySession {
  state: JourneyState
  destinationQuery: string
  originId: string | null
  destinationId: string | null
  routeId: string | null
  message: string
  offRoute: boolean
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

const PROFILE_STORAGE_KEY = 'transense.demo-profile.v1'
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

function readProfile(): DemoProfile | null {
  try {
    const storedProfile = window.localStorage.getItem(PROFILE_STORAGE_KEY)
    if (!storedProfile) {
      return null
    }

    const parsedProfile: unknown = JSON.parse(storedProfile)
    if (!isRecord(parsedProfile) || typeof parsedProfile.displayName !== 'string') {
      return null
    }

    const displayName = parsedProfile.displayName.trim()
    if (!displayName) {
      return null
    }

    return {
      displayName,
      createdAt: typeof parsedProfile.createdAt === 'string' ? parsedProfile.createdAt : new Date().toISOString(),
    }
  } catch (error: unknown) {
    console.warn('Transense could not read the local demo profile.', error)
    return null
  }
}

function persistProfile(profile: DemoProfile): boolean {
  try {
    window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile))
    return true
  } catch (error: unknown) {
    console.warn('Transense could not save the local demo profile.', error)
    return false
  }
}

function clearStoredProfile(): boolean {
  try {
    window.localStorage.removeItem(PROFILE_STORAGE_KEY)
    return true
  } catch (error: unknown) {
    console.warn('Transense could not clear the local demo profile.', error)
    return false
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

function mapOptionalStaticData(value: unknown): OptionalStaticData | null {
  if (!isRecord(value)) return null
  const payload = isRecord(value.data) ? value.data : value
  const source = typeof value.source === 'string' ? value.source : ''
  const attribution = typeof value.attribution === 'string' ? value.attribution : ''
  const rawStops = Array.isArray(payload.stops) ? payload.stops : payload.stations
  const rawRoutes = Array.isArray(payload.routes) ? payload.routes : payload.lines
  const rawTimetables = payload.timetables
  if (!Array.isArray(rawStops) || !Array.isArray(rawRoutes) || !Array.isArray(rawTimetables) || !rawTimetables.length) return null

  const stops = rawStops.flatMap((candidate): Stop[] => {
    if (!isRecord(candidate)) return []
    const id = typeof candidate.id === 'string' ? candidate.id : typeof candidate.station_id === 'string' ? candidate.station_id : ''
    const name = typeof candidate.name === 'string' ? candidate.name : typeof candidate.station_name === 'string' ? candidate.station_name : ''
    return id && name ? [{ id, name }] : []
  })
  const routes = rawRoutes.flatMap((candidate): Route[] => {
    if (!isRecord(candidate)) return []
    const id = typeof candidate.id === 'string' ? candidate.id : typeof candidate.line_id === 'string' ? candidate.line_id : ''
    const name = typeof candidate.name === 'string' ? candidate.name : typeof candidate.line_name === 'string' ? candidate.line_name : ''
    const rawStopIds = Array.isArray(candidate.stop_ids) ? candidate.stop_ids : candidate.station_ids
    const stopIds = Array.isArray(rawStopIds) ? rawStopIds.filter((stopId): stopId is string => typeof stopId === 'string') : []
    return id && name && stopIds.length ? [{ id, name, stop_ids: stopIds }] : []
  })
  if (!stops.length || !routes.length || routes.some((route) => route.stop_ids.some((stopId) => !stops.some((stop) => stop.id === stopId)))) {
    return null
  }

  const sourceLabel = source === 'seed' ? 'Seed demo' : attribution || 'Commute Data Platform · ODbL-1.0'
  return { stops, routes, timetableCount: rawTimetables.length, sourceLabel }
}

function useOptionalStaticData(fallbackState: TransitState): { state: TransitState; detail: string; source: 'seed' | 'optional' | 'fallback' } {
  const configuredSource = `${apiBaseUrl}/api/schedule`
  const [result, setResult] = useState<{ data: OptionalStaticData | null; detail: string; source: 'seed' | 'optional' | 'fallback' }>(() => ({
    data: null,
    detail: 'Memeriksa sumber jadwal statis melalui backend demo…',
    source: 'fallback',
  }))

  useEffect(() => {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 4000)
    fetch(configuredSource, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return mapOptionalStaticData(await response.json())
      })
      .then((data) => {
        if (!data) throw new Error('mapping stasiun/lin tidak valid')
         const source = data.sourceLabel === 'Seed demo' ? 'seed' : 'optional'
         setResult({ data, detail: `${data.sourceLabel} digunakan untuk ${data.timetableCount} timetable statis.`, source })
      })
      .catch((error: unknown) => {
        const detail = error instanceof DOMException && error.name === 'AbortError'
          ? 'Commute API melewati batas waktu; memakai seed demo.'
          : `Commute API gagal; memakai seed demo (${error instanceof Error ? error.message : 'respons tidak dikenal'}).`
        setResult({ data: null, detail, source: 'fallback' })
      })
      .finally(() => window.clearTimeout(timeout))
    return () => {
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [configuredSource])

  const state = result.data ? { ...fallbackState, stops: result.data.stops, routes: result.data.routes } : fallbackState
  return { state, detail: result.detail, source: result.source }
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

interface RouteContext {
  routeName: string
  currentStopName: string
  nextStopName: string
  vehicleId: string
  etaMinutes: number
}

function getNearestRouteContext(state: TransitState | null): RouteContext | null {
  if (!state) {
    return null
  }

  const vehicle = state.vehicles[0]
  if (!vehicle) {
    return null
  }

  const trip = state.trips.find((candidate) => candidate.id === vehicle.trip_id)
  const route = trip ? state.routes.find((candidate) => candidate.id === trip.route_id) : undefined
  const currentStop = state.stops.find((stop) => stop.id === vehicle.position)
  const nextStopId = route?.stop_ids.find((stopId) => stopId !== vehicle.position)
  const nextStop = nextStopId ? state.stops.find((stop) => stop.id === nextStopId) : undefined
  const eta = state.etas.find((candidate) => candidate.vehicle_id === vehicle.id)

  if (!route || !currentStop || !nextStop || !eta) {
    return null
  }

  return {
    routeName: route.name,
    currentStopName: currentStop.name,
    nextStopName: nextStop.name,
    vehicleId: vehicle.id,
    etaMinutes: eta.minutes,
  }
}

function StatusCard({
  transitState,
  connection,
  simulationDetail,
  onUpdate,
  onReset,
}: {
  transitState: TransitState | null
  connection: ConnectionState
  simulationDetail: string
  onUpdate: () => void
  onReset: () => void
}) {
  const context = getNearestRouteContext(transitState)
  const isConnected = connection.status === 'connected'

  return (
    <section className="status-card" aria-labelledby="status-card-heading">
      <div className="status-card__topline">
        <p className="eyebrow">STATUS RUTE TERDEKAT</p>
        <span className="state-badge state-badge--warning">SIMULASI</span>
      </div>
      <h2 id="status-card-heading">{context ? `${context.routeName} · ${context.currentStopName}` : 'Menunggu rute seeded'}</h2>
      <p className="status-card__message">
        {context
          ? `Armada ${context.vehicleId} menuju ${context.nextStopName}. Perkiraan tiba dari simulasi lokal.`
          : 'Seeded nearest-route context akan tampil setelah backend terhubung.'}
      </p>
      <div className="eta-display">
        <strong>{context ? context.etaMinutes : '—'}</strong>
        <span>menit</span>
        <span className="eta-display__note">Data demo tersimulasi</span>
      </div>
      <div className="simulation-controls" aria-label="Kontrol simulasi transit lokal">
        <p className="simulation-controls__detail" role="status">{simulationDetail}</p>
        <div className="simulation-controls__actions">
          <button className="secondary-button" type="button" onClick={onUpdate} disabled={!isConnected || !context}>
            Simulasikan ETA -1 menit
          </button>
          <button className="secondary-button" type="button" onClick={onReset} disabled={!isConnected}>
            Reset ke seed
          </button>
        </div>
      </div>
      <div className="status-card__footer"><span className="status-pulse" aria-hidden="true" /> Belum terhubung ke feed TransJakarta riil</div>
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

function HomePage({
  displayName,
  transitState,
  connection,
  simulationDetail,
  onUpdate,
  onReset,
}: {
  displayName: string
  transitState: TransitState | null
  connection: ConnectionState
  simulationDetail: string
  onUpdate: () => void
  onReset: () => void
}) {
  const [gtfsStops, setGtfsStops] = useState<Stop[]>(() => transitState?.stops ?? SEEDED_TRANSIT_STATE.stops)
  const [routeShapes, setRouteShapes] = useState<{ id: string; name: string; color: string; coordinates: [number, number][] }[]>([])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${apiBaseUrl}/api/gtfs/stops`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return
        const data = await res.json() as { stops: { id: string; name: string; lat: number; lng: number }[] }
        if (data.stops.length) setGtfsStops(data.stops.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng })))
      })
      .catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const load = async () => {
      const res = await fetch(`${apiBaseUrl}/api/gtfs/routes`, { signal: controller.signal })
      if (!res.ok) return
      const data = await res.json() as { routes: { id: string; name: string; color: string }[] }
      const topRoutes = data.routes.filter((r) => /^\d/.test(r.name)).slice(0, 8)
      const shapes: { id: string; name: string; color: string; coordinates: [number, number][] }[] = []
      for (const route of topRoutes) {
        try {
          const shapeRes = await fetch(`${apiBaseUrl}/api/gtfs/route/${encodeURIComponent(route.id)}/shape`, { signal: controller.signal })
          if (!shapeRes.ok) continue
          const shapeData = await shapeRes.json() as { coordinates: [number, number][] }
          if (shapeData.coordinates.length) {
            shapes.push({ id: route.id, name: route.name, color: route.color, coordinates: shapeData.coordinates })
          }
        } catch {
          /* skip */
        }
      }
      setRouteShapes(shapes)
    }
    void load()
    return () => controller.abort()
  }, [])

  const displayStops = gtfsStops.length > 2 ? gtfsStops : (transitState?.stops ?? SEEDED_TRANSIT_STATE.stops)

  return (
    <main className="page-content home-page">
      <section className="welcome-card" aria-labelledby="welcome-heading">
        <span className="welcome-card__mark" aria-hidden="true"><img className="brand-logo-img" src="/logos/Logo-Transense.png" alt="" /></span>
        <div className="welcome-card__body">
          <p className="eyebrow">SELAMAT DATANG KEMBALI</p>
          <h2 id="welcome-heading">Halo, {displayName}!</h2>
          <p>Semua informasi penting perjalananmu, dalam satu tampilan.</p>
        </div>
      </section>
      <SearchEntry />
      <div className="home-map-stage">
        <MapboxMap stops={displayStops} routeShapes={routeShapes} />
        <BottomSheet>
          <StatusCard transitState={transitState} connection={connection} simulationDetail={simulationDetail} onUpdate={onUpdate} onReset={onReset} />
        </BottomSheet>
      </div>
    </main>
  )
}

function SchedulePage({
  transitState,
  sourceDetail,
  source,
  simulationDetail,
  onUpdate,
  onReset,
  onSimulateNotification,
}: {
  transitState: TransitState
  sourceDetail: string
  source: 'seed' | 'optional' | 'fallback'
  simulationDetail: string
  onUpdate: () => void
  onReset: () => void
  onSimulateNotification: (kind: Exclude<NotificationKind, 'off_route'>) => void
}) {
  const vibrationPatternsReady = areVibrationPatternsDistinct()
  return (
    <main className="page-content inner-page">
      <section className="page-intro">
        <p className="eyebrow">JADWAL TRANSJAKARTA / DEMO</p>
        <h2>Jadwal & armada</h2>
        <p>Posisi, rute, dan ETA ini adalah simulasi seeded. Tidak mewakili feed TransJakarta live.</p>
      </section>
      <div className="source-note" role="status">
        <strong>{source === 'optional' ? 'SUMBER STATIS OPSIONAL' : 'SUMBER SEED DEMO'}</strong>
        <span>{sourceDetail}</span>
        {source === 'optional' ? <span>Data static source: Commute Data Platform · ODbL-1.0. Posisi live, ETA, dan insiden tetap simulasi lokal.</span> : null}
      </div>
      <section className="schedule-list" aria-label="Jadwal armada seeded">
        {transitState.vehicles.map((vehicle) => {
          const trip = transitState.trips.find((candidate) => candidate.id === vehicle.trip_id)
          const route = trip ? transitState.routes.find((candidate) => candidate.id === trip.route_id) : undefined
          const position = transitState.stops.find((stop) => stop.id === vehicle.position)
          const eta = transitState.etas.find((candidate) => candidate.vehicle_id === vehicle.id)
          const destination = eta ? transitState.stops.find((stop) => stop.id === eta.stop_id) : undefined
          return (
            <article className="schedule-card" key={vehicle.id}>
              <div className="schedule-card__topline">
                <span className="state-badge state-badge--warning">SIMULASI</span>
                <span>{vehicle.id}</span>
              </div>
              <h3>{route?.name || 'Rute tidak tersedia'}</h3>
              <div className="schedule-card__route">
                <span>{position?.name || vehicle.position}</span>
                <span aria-hidden="true">→</span>
                <span>{destination?.name || 'Tujuan seeded'}</span>
              </div>
              <div className="schedule-card__eta"><strong>{eta?.minutes ?? vehicle.eta_minutes}</strong><span>menit ETA</span></div>
            </article>
          )
        })}
      </section>
      <section className="simulation-controls" aria-label="Kontrol schedule demo">
        <p className="simulation-controls__detail" role="status">{simulationDetail}</p>
        <div className="simulation-controls__actions">
          <button className="secondary-button" type="button" onClick={onUpdate}>Maju 1 menit</button>
          <button className="secondary-button" type="button" onClick={onReset}>Reset ke seed</button>
        </div>
        <div className="schedule-test-actions">
          <p className="eyebrow">UJI KANAL NOTIFIKASI / SIMULASI</p>
          <p className="simulation-controls__detail">{vibrationPatternsReady ? '3 pola getar terdokumentasi berbeda; visual tetap utama.' : 'Pola getar perlu diperiksa sebelum demo.'}</p>
          <button className="secondary-button" type="button" onClick={() => onSimulateNotification('vehicle_approaching')}>Uji armada mendekat</button>
          <button className="secondary-button" type="button" onClick={() => onSimulateNotification('destination_approaching')}>Uji halte tujuan</button>
          <button className="secondary-button" type="button" onClick={() => onSimulateNotification('incident')}>Uji insiden</button>
        </div>
      </section>
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

function TranscribePage({ transcription }: { transcription: TranscriptionController }) {
  const [errorMessage, setErrorMessage] = useState('')

  const scribe = useScribe({
    modelId: 'scribe_v2_realtime',
    onCommittedTranscript: (data: { text: string }) => {
      if (data.text.trim()) {
        transcription.saveTranscript(data.text.trim())
      }
    },
    onError: (error: Error | Event) => {
      setErrorMessage(error instanceof Error ? error.message : 'Terjadi error pada sesi transkripsi.')
    },
    onDisconnect: () => {
      setErrorMessage('')
    },
  })

  const handleStart = async () => {
    setErrorMessage('')
    try {
      const response = await fetch(`${apiBaseUrl}/api/scribe-token`)
      if (!response.ok) {
        const errText = await response.text()
        setErrorMessage(`Gagal mendapatkan token: ${errText}`)
        return
      }
      const tokenData: { token: string } = await response.json()
      await scribe.connect({
        token: tokenData.token,
        microphone: { echoCancellation: true, noiseSuppression: true },
      })
    } catch (error: unknown) {
      setErrorMessage(error instanceof Error ? error.message : 'Gagal memulai transkripsi ElevenLabs.')
    }
  }

  const handleStop = () => {
    scribe.disconnect()
  }

  const connected = scribe.isConnected
  const liveText = scribe.partialTranscript

  const sourceLabel: Record<TranscriptionSource, string> = {
    live: 'LIVE / BACKEND',
    mock: 'MOCK DEMO',
    degraded: 'DEGRADED',
  }

  return (
    <main className="transcribe-page">
      <section className="transcribe-intro">
        <p className="eyebrow">TRANSCRIBE / PERCAKAPAN LANGSUNG</p>
        <h2>Ubah percakapan menjadi teks</h2>
        <p>Untuk percakapan orang-ke-orang melalui mikrofon ponsel. Audio mentah tidak disimpan sebagai history.</p>
      </section>

      <section className="transcribe-live" aria-labelledby="transcribe-live-heading">
        <button
          className={`transcribe-mic-btn${connected ? ' transcribe-mic-btn--active' : ''}`}
          type="button"
          onClick={connected ? handleStop : handleStart}
          aria-label={connected ? 'Hentikan transcribe' : 'Mulai transcribe'}
        >
          <svg className="transcribe-mic-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" />
          </svg>
        </button>
        <h3 id="transcribe-live-heading">{connected ? 'Mendengarkan…' : 'Ketuk untuk mulai mendengarkan'}</h3>
        <p className="transcribe-live__detail" role="status">
          {connected ? 'ElevenLabs Scribe v2 — transkripsi bahasa Indonesia real-time.' : 'Ketuk mikrofon untuk mulai. Audio diproses melalui ElevenLabs Scribe.'}
        </p>
        <div className="transcribe-live__badges">
          <span className={`state-badge state-badge--${connected ? 'safe' : 'warning'}`}>{connected ? 'LIVE' : 'SIAP'}</span>
        </div>
        {errorMessage ? (
          <div className="notice-box notice-box--danger" role="alert"><strong>Gagal tersambung</strong><span>{errorMessage}</span></div>
        ) : null}
      </section>

      <div className="transcribe-stage">
        <section className="transcript-card" aria-labelledby="transcript-output-heading">
          <div className="transcript-card__header">
            <div>
              <p className="eyebrow">HASIL TERBACA</p>
              <h3 id="transcript-output-heading">Transkrip percakapan</h3>
            </div>
            <span className={`state-badge state-badge--${connected ? 'safe' : transcription.current ? 'warning' : 'placeholder'}`}>
              {connected ? 'LIVE' : transcription.current ? sourceLabel[transcription.current.provider] : 'KOSONG'}
            </span>
          </div>
          {connected || liveText ? (
            <div className="transcript-card__live" aria-live="polite">
              <p className="live-transcript__text">
                {liveText || 'Menunggu suara…'}
                <span className="live-transcript__caret" aria-hidden="true">|</span>
              </p>
            </div>
          ) : transcription.current ? (
            <>
              <p className="transcript-card__text">{transcription.current.text}</p>
              <time dateTime={transcription.current.createdAt}>{new Date(transcription.current.createdAt).toLocaleString('id-ID')}</time>
            </>
          ) : (
            <div className="transcript-card__empty"><strong>Belum ada teks</strong><span>Ketuk mikrofon untuk memulai. Hasil percakapan akan muncul kata per kata di sini.</span></div>
          )}
        </section>

        <BottomSheet>
          <div className="section-heading">
            <p className="eyebrow">HISTORY / RETENSI 7 HARI</p>
            <h3>Percakapan tersimpan</h3>
          </div>
          <div className="source-note" role="status"><strong>STATUS HISTORY</strong><span>{transcription.historyDetail}</span><span>Hanya teks fungsional yang ditampilkan; raw audio dan ambient noise tidak masuk history.</span></div>
          {transcription.history.length ? (() => {
            const today = new Date()
            const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate())

            const grouped: { label: string; entries: TranscriptRecord[] }[] = []
            for (const transcript of transcription.history) {
              const createdAt = new Date(transcript.createdAt)
              const entryDate = new Date(createdAt.getFullYear(), createdAt.getMonth(), createdAt.getDate())
              const diffDays = Math.floor((todayDate.getTime() - entryDate.getTime()) / 86400000)
              let label: string
              if (diffDays === 0) {
                label = 'Hari ini'
              } else if (diffDays === 1) {
                label = 'Kemarin'
              } else if (diffDays < 7) {
                label = `${diffDays} hari lalu`
              } else {
                label = createdAt.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })
              }
              const lastGroup = grouped[grouped.length - 1]
              if (lastGroup && lastGroup.label === label) {
                lastGroup.entries.push(transcript)
              } else {
                grouped.push({ label, entries: [transcript] })
              }
            }

            return grouped.map((group) => (
              <div className="history-group" key={group.label}>
                <p className="history-group__label">{group.label}</p>
                {group.entries.map((transcript) => (
                  <article className="transcript-history-card" key={transcript.id}>
                    <div className="transcript-history-card__topline">
                      <span className={`state-badge state-badge--${transcript.provider === 'live' ? 'safe' : 'warning'}`}>{sourceLabel[transcript.provider]}</span>
                      <time dateTime={transcript.createdAt}>{new Date(transcript.createdAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</time>
                    </div>
                    <p>{transcript.text}</p>
                    <div className="transcript-history-card__footer">
                      <span>{transcript.pinned ? 'Tersimpan · dikecualikan dari cleanup' : transcript.simulated ? 'Mock sesi demo · belum tentu persisten' : 'Retensi demo: 7 hari'}</span>
                      <button className="secondary-button" type="button" onClick={() => transcription.pin(transcript.id)}>{transcript.pinned ? 'Lepas simpan' : 'Simpan / pin'}</button>
                    </div>
                  </article>
                ))}
              </div>
            ))
          })() : <div className="empty-state"><span className="empty-state__mark" aria-hidden="true">□</span><h3>Belum ada history</h3><p>Hasil percakapan akan muncul di sini setelah sesi menghasilkan teks fungsional.</p></div>}
        </BottomSheet>
      </div>
    </main>
  )
}

function AntarAkuPage({
  transitState,
  session,
  notifications,
  onQueryChange,
  onMatch,
  onConfirm,
  onEnd,
  onRestart,
  onSimulateOffRoute,
  onResolveOffRoute,
}: {
  transitState: TransitState
  session: JourneySession
  notifications: NotificationRecord[]
  onQueryChange: (query: string) => void
  onMatch: () => void
  onConfirm: () => void
  onEnd: () => void
  onRestart: () => void
  onSimulateOffRoute: () => void
  onResolveOffRoute: () => void
}) {
  const origin = session.originId ? transitState.stops.find((stop) => stop.id === session.originId) : undefined
  const destination = session.destinationId ? transitState.stops.find((stop) => stop.id === session.destinationId) : undefined
  const route = session.routeId ? transitState.routes.find((candidate) => candidate.id === session.routeId) : undefined
  const journeyNotifications = notifications.filter((notification) => notification.kind !== 'off_route').slice(0, 3)

  return (
    <main className="page-content inner-page journey-page">
      <section className="page-intro">
        <p className="eyebrow">ANTAR AKU / JOURNEY STATE</p>
        <h2>Temani perjalananmu</h2>
        <p>Halte dicocokkan dari konteks seed demo. Tidak ada geolocation, peta interaktif, atau posisi live pengguna.</p>
      </section>
      <div className="journey-stepper" aria-label="Status perjalanan">
        {(['entry', 'matching', 'route', 'active', 'ended'] as JourneyState[]).map((step) => <span className={session.state === step ? 'journey-step journey-step--active' : 'journey-step'} key={step}>{step}</span>)}
      </div>
      {session.message ? <div className="notice-box" role="status"><strong>{session.message}</strong><span>Gunakan nama halte seeded yang tersedia; demo tidak membuat halte baru.</span></div> : null}
      {session.state === 'entry' || session.state === 'ended' ? (
        <section className="journey-entry" aria-labelledby="journey-entry-heading">
          <span className="state-badge state-badge--warning">SIMULASI SEED</span>
          <h3 id="journey-entry-heading">{session.state === 'ended' ? 'Perjalanan selesai' : 'Mau diantar ke mana?'}</h3>
          <p>Asal seeded: <strong>Halte Karet</strong>. Coba tujuan <strong>Halte Bundaran HI</strong>.</p>
          <label htmlFor="journey-destination">Tujuan halte</label>
          <input id="journey-destination" value={session.destinationQuery} onChange={(event) => onQueryChange(event.target.value)} placeholder="Contoh: Bundaran HI" />
          <button className="primary-button" type="button" onClick={onMatch}>Cocokkan halte terdekat <span aria-hidden="true">→</span></button>
        </section>
      ) : null}
      {session.state === 'matching' ? <div className="journey-state-card"><span className="state-badge state-badge--warning">MATCHING</span><h3>Mencocokkan halte seeded…</h3><p>Context demo sedang mencari tujuan yang tersedia.</p></div> : null}
      {session.state === 'route' && route && origin && destination ? (
        <section className="journey-route-card" aria-labelledby="route-heading">
          <span className="state-badge state-badge--safe">ROUTE READY</span>
          <h3 id="route-heading">{route.name}</h3>
          <p>{origin.name} → {destination.name}</p>
          <ol className="stop-list">
            {route.stop_ids.map((stopId) => <li key={stopId} className={stopId === origin.id || stopId === destination.id ? 'stop-list__stop stop-list__stop--endpoint' : 'stop-list__stop'}>{transitState.stops.find((stop) => stop.id === stopId)?.name || stopId}</li>)}
          </ol>
          <button className="primary-button" type="button" onClick={onConfirm}>Mulai perjalanan demo</button>
        </section>
      ) : null}
      {session.state === 'active' && route && origin && destination ? (
        <section className="journey-route-card journey-route-card--active" aria-labelledby="active-journey-heading">
          <div className="journey-route-card__topline"><span className="state-badge state-badge--safe">AKTIF</span><span className="state-badge state-badge--warning">SIMULASI</span></div>
          <h3 id="active-journey-heading">Menuju {destination.name}</h3>
          <p>{route.name} · asal {origin.name}</p>
          {session.offRoute ? <div className="off-route-warning" role="alert"><strong>Keluar rute simulasi</strong><span>Ini trigger debug terkontrol, bukan hasil geolocation. Kembali ke jalur demo untuk menyelesaikan warning.</span><button className="secondary-button" type="button" onClick={onResolveOffRoute}>Tandai kembali ke rute</button></div> : null}
          <ol className="stop-list">
            {route.stop_ids.map((stopId, index) => <li key={stopId} className={stopId === destination.id ? 'stop-list__stop stop-list__stop--endpoint' : index === 0 ? 'stop-list__stop stop-list__stop--current' : 'stop-list__stop'}>{transitState.stops.find((stop) => stop.id === stopId)?.name || stopId}</li>)}
          </ol>
          <div className="journey-actions"><button className="secondary-button" type="button" onClick={onSimulateOffRoute}>Simulasikan keluar rute</button><button className="secondary-button" type="button" onClick={onEnd}>Akhiri perjalanan</button></div>
          {journeyNotifications.length ? <div className="journey-notification-list"><p className="eyebrow">NOTIFIKASI DALAM JOURNEY</p>{journeyNotifications.map((notification) => <p key={notification.id}><strong>{notification.title}:</strong> {notification.message}</p>)}</div> : null}
        </section>
      ) : null}
      {session.state === 'ended' ? <button className="secondary-button" type="button" onClick={onRestart}>Mulai journey baru</button> : null}
    </main>
  )
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
    { screen: 'antar-aku', label: 'Antar Aku', icon: '→' },
    { screen: 'transcribe', label: 'Transcribe', icon: '✎' },
    { screen: 'delays', label: 'Keterlambatan', icon: '!' },
    { screen: 'schedule', label: 'Jadwal', icon: '▦' },
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
  const [journeySession, setJourneySession] = useState<JourneySession>({ state: 'entry', destinationQuery: '', originId: null, destinationId: null, routeId: null, message: '', offRoute: false })
  const [dismissedNotificationIds, setDismissedNotificationIds] = useState<string[]>([])
  const backend = useBackendConnection()
  const optionalData = useOptionalStaticData(backend.transitState || SEEDED_TRANSIT_STATE)
  const currentNotification = backend.notifications.find((notification) => !dismissedNotificationIds.includes(notification.id)) || null

  useEffect(() => {
    const offRouteNotification = backend.notifications[0]
    if (offRouteNotification?.kind === 'off_route' && offRouteNotification.offRouteStatus === 'resolved' && journeySession.state === 'active' && journeySession.offRoute) {
      setJourneySession((current) => ({ ...current, offRoute: false, message: 'Status resolved: simulasi keluar rute selesai.' }))
    } else if (offRouteNotification?.kind === 'off_route' && offRouteNotification.offRouteStatus !== 'resolved' && journeySession.state === 'active' && !journeySession.offRoute) {
      setJourneySession((current) => ({ ...current, offRoute: true, message: 'Peringatan keluar rute simulasi diterima.' }))
    }
  }, [backend.notifications, journeySession.offRoute, journeySession.state])

  const title = useMemo(() => {
    if (screen === 'home') return 'Beranda'
    if (screen === 'delays') return 'Keterlambatan'
    if (screen === 'profile') return 'Profil'
    if (screen === 'schedule') return 'Jadwal & armada'
    if (screen === 'antar-aku') return 'Antar Aku'
    if (screen === 'transcribe') return 'Transcribe'
    return 'Fitur Transense'
  }, [screen])

  const handleNavigate = (nextScreen: Exclude<Screen, 'placeholder'>) => {
    setScreen(nextScreen)
  }

  const handleJourneyMatch = () => {
    const query = journeySession.destinationQuery.trim()
    setJourneySession((current) => ({ ...current, state: 'matching', message: query ? 'Mencocokkan tujuan dengan halte seeded…' : 'Tujuan belum diisi.', offRoute: false }))
    if (!query) {
      setJourneySession((current) => ({ ...current, state: 'entry', message: 'Masukkan nama halte tujuan untuk memulai matching.' }))
      return
    }

    window.setTimeout(() => {
      const journeyState = optionalData.state
      const origin = journeyState.stops[0]
      const destination = matchSeededStop(journeyState, query)
      if (!origin || !destination) {
        setJourneySession((current) => ({ ...current, state: 'entry', originId: null, destinationId: null, routeId: null, message: 'Halte tujuan tidak ditemukan di seed demo.', offRoute: false }))
        return
      }
      const route = findRouteBetweenStops(journeyState, origin.id, destination.id)
      if (!route) {
        setJourneySession((current) => ({ ...current, state: 'entry', originId: origin.id, destinationId: destination.id, routeId: null, message: 'Rute halte-ke-halte belum tersedia untuk pasangan ini.', offRoute: false }))
        return
      }
      setJourneySession((current) => ({ ...current, state: 'route', originId: origin.id, destinationId: destination.id, routeId: route.id, message: 'Halte asal dan tujuan ditemukan dari konteks seeded.', offRoute: false }))
    }, 320)
  }

  const handleJourneyRestart = () => setJourneySession({ state: 'entry', destinationQuery: '', originId: null, destinationId: null, routeId: null, message: '', offRoute: false })

  return (
    <div className={`app-frame${screen === 'home' || screen === 'transcribe' ? ' app-frame--home' : ''}`}>
      {screen === 'home' ? null : <AppHeader title={title} />}
      <NotificationRenderer notification={currentNotification} onDismiss={() => {
        if (currentNotification) setDismissedNotificationIds((current) => current.includes(currentNotification.id) ? current : [...current, currentNotification.id])
      }} />
      {screen === 'home' ? <HomePage displayName={profile.displayName} transitState={backend.transitState} connection={backend.connection} simulationDetail={backend.simulationDetail} onUpdate={backend.updateTransit} onReset={backend.resetTransit} /> : null}
      {screen === 'schedule' ? <SchedulePage transitState={optionalData.state} sourceDetail={optionalData.detail} source={optionalData.source} simulationDetail={backend.simulationDetail} onUpdate={backend.updateTransit} onReset={backend.resetTransit} onSimulateNotification={backend.simulateNotification} /> : null}
      {screen === 'delays' ? <DelaysPage incidentRecords={backend.incidentRecords} onPinIncident={backend.pinIncident} /> : null}
      {screen === 'transcribe' ? <TranscribePage transcription={backend.transcription} /> : null}
      {screen === 'antar-aku' ? <AntarAkuPage transitState={optionalData.state} session={journeySession} notifications={backend.notifications} onQueryChange={(destinationQuery) => setJourneySession((current) => ({ ...current, destinationQuery, message: '' }))} onMatch={handleJourneyMatch} onConfirm={() => setJourneySession((current) => ({ ...current, state: 'active', message: 'Journey aktif. Status armada dan notifikasi akan tampil di konteks ini.' }))} onEnd={() => setJourneySession((current) => ({ ...current, state: 'ended', offRoute: false, message: 'Journey berakhir di sesi demo.' }))} onRestart={handleJourneyRestart} onSimulateOffRoute={() => setJourneySession((current) => ({ ...current, offRoute: true, message: 'Keluar rute disimulasikan secara manual untuk demo.' }))} onResolveOffRoute={() => setJourneySession((current) => ({ ...current, offRoute: false, message: 'Status resolved: kembali ke rute demo (tanpa klaim posisi real).' }))} /> : null}
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

  const handleCompleteOnboarding = (displayName: string) => {
    const nextProfile: DemoProfile = { displayName, createdAt: new Date().toISOString() }
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
