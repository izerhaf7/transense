// Backend connection layer: WebSocket `transit-demo.v1` client, runtime type
// guards, and the transcription/incident state machine. This is the single
// owner of the backend contract on the frontend.

import { useEffect, useRef, useState } from 'react'

import { cloneTransitState, SEEDED_TRANSIT_STATE } from './journey'
import type { Eta, Incident, Route, Stop, TransitState, Trip, Vehicle } from './journey'
import { apiBaseUrl, toWebSocketUrl } from './api'
import type {
  BackendConnection,
  ConnectionAck,
  ConnectionState,
  DestinationApproachingNotification,
  IncidentNotification,
  IncidentRecord,
  MicrophonePermission,
  NotificationKind,
  NotificationRecord,
  OffRouteNotification,
  RampRequestAck,
  TransitError,
  TransitMessageWithNotifications,
  TransitReset,
  TransitUpdate,
  TranscriptRecord,
  TranscriptionErrorMessage,
  TranscriptionResultMessage,
  TranscriptionSessionStartedMessage,
  TranscriptionSessionState,
  VehicleApproachingNotification,
} from './types'

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

function isRampRequestAck(value: unknown): value is RampRequestAck {
  return isRecord(value)
    && value.type === 'ramp.request.ack'
    && typeof value.stop_id === 'string'
    && value.status === 'received'
    && isUtcTimestamp(value.occurred_at)
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
  if (isConnectionAck(value) || isTransitUpdate(value) || isTransitReset(value) || isTransitError(value) || isTranscriptionResult(value) || isTranscriptionSessionStarted(value) || isTranscriptionError(value) || isVehicleApproachingNotification(value) || isDestinationApproachingNotification(value) || isIncidentNotification(value) || isOffRouteNotification(value) || isRampRequestAck(value)) {
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

export function useBackendConnection(): BackendConnection {
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
  const [lastRampAck, setLastRampAck] = useState<string | null>(null)

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
            } else if (message.type === 'ramp.request.ack') {
              setLastRampAck(`Petugas menerima permintaan ramp di ${message.stop_id}.`)
              setSimulationDetail('Konfirmasi permintaan ramp diterima dari backend.')
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

  const sendRampRequest = (stopId: string) => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setConnection((current) => ({
        ...current,
        status: 'offline',
        detail: 'Backend belum tersedia. Shell tetap dapat digunakan.',
      }))
      setLastRampAck(null)
      setSimulationDetail('Backend belum tersedia; permintaan ramp tidak terkirim.')
      return
    }
    socket.send(JSON.stringify({ type: 'ramp.request', stop_id: stopId }))
    setLastRampAck(null)
    setSimulationDetail(`Permintaan ramp dikirim untuk ${stopId}.`)
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
    lastRampAck,
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
    sendRampRequest,
  }
}
