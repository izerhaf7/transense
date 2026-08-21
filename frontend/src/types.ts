// Shared domain + transport types for the Transense frontend shell.
// Pure (no React, no DOM) so they can be imported anywhere without side effects.

import type { TransitState } from './journey'

export type Screen = 'onboarding' | 'home' | 'delays' | 'profile' | 'schedule' | 'antar-aku' | 'transcribe' | 'side-by-side' | 'netra-scan' | 'placeholder'
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline'
export type NotificationKind = 'vehicle_approaching' | 'destination_approaching' | 'incident' | 'off_route'
export type MicrophonePermission = 'unknown' | 'granted' | 'denied' | 'unsupported'
export type TranscriptionSource = 'live' | 'mock' | 'degraded'

export interface ConnectionState {
  status: ConnectionStatus
  detail: string
  attempts: number
}

export interface ConnectionAck {
  type: 'connection.ack'
  protocol: 'transit-demo.v1'
  state: TransitState
}

export interface TransitUpdate {
  type: 'transit.update'
  event_id: string
  vehicle_id: string
  eta_minutes: number
  position: string
  occurred_at: string
  state_version: number
}

export interface TransitReset {
  type: 'transit.reset'
  state: TransitState
  occurred_at: string
  state_version: number
}

export interface TransitError {
  type: 'error'
  code: string
  message: string
}

export interface TranscriptionResultMessage {
  type: 'transcription.result'
  id: string
  session_id: string
  text: string
  created_at: string
  provider: 'live' | 'mock'
}

export interface TranscriptionSessionStartedMessage {
  type: 'transcription.session.started'
  session_id: string
  source: 'conversation_microphone'
  provider: 'cloud' | 'mock'
  mode: 'live' | 'mock'
}

export interface TranscriptionErrorMessage {
  type: 'transcription.session.error'
  session_id?: string
  code: string
  message: string
}

export interface RampRequestAck {
  type: 'ramp.request.ack'
  stop_id: string
  status: 'received'
  occurred_at: string
}

export type TransitMessage = ConnectionAck | TransitUpdate | TransitReset | TransitError | TranscriptionResultMessage | TranscriptionSessionStartedMessage | TranscriptionErrorMessage | RampRequestAck

export interface NotificationBase {
  type: `notification.${Exclude<NotificationKind, 'off_route'>}`
  event_id: string
  occurred_at: string
  route_id?: string
  message?: string
}

export interface VehicleApproachingNotification extends NotificationBase {
  type: 'notification.vehicle_approaching'
  vehicle_id: string
  stop_id: string
  eta_minutes: number
}

export interface DestinationApproachingNotification extends NotificationBase {
  type: 'notification.destination_approaching'
  vehicle_id: string
  stop_id: string
  eta_minutes: number
}

export interface IncidentNotification extends NotificationBase {
  type: 'notification.incident'
  incident_id: string
  status: string
  cause: string
  action: string
  instruction: string
  updated_at: string
}

export interface OffRouteNotification {
  type: 'journey.off_route'
  event_id: string
  occurred_at: string
  route_id?: string
  status?: 'warning' | 'resolved'
  message: string
}

export type TransitNotification = VehicleApproachingNotification | DestinationApproachingNotification | IncidentNotification | OffRouteNotification
export type TransitMessageWithNotifications = TransitMessage | TransitNotification

export interface TranscriptRecord {
  id: string
  sessionId: string
  text: string
  createdAt: string
  provider: 'live' | 'mock'
  pinned: boolean
  simulated: boolean
}

export interface TranscriptionSessionState {
  status: 'idle' | 'requesting' | 'active' | 'stopping' | 'denied'
  source: TranscriptionSource
  sessionId: string | null
  detail: string
}

export interface TranscriptionController {
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

export interface NotificationRecord {
  id: string
  kind: NotificationKind
  title: string
  message: string
  occurredAt: string
  incident?: IncidentRecord
  offRouteStatus?: 'warning' | 'resolved'
}

export interface IncidentRecord {
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

export interface BackendConnection {
  connection: ConnectionState
  transitState: TransitState | null
  simulationDetail: string
  notifications: NotificationRecord[]
  incidentRecords: IncidentRecord[]
  transcription: TranscriptionController
  lastRampAck: string | null
  updateTransit: () => void
  resetTransit: () => void
  simulateNotification: (kind: Exclude<NotificationKind, 'off_route'>) => void
  pinIncident: (incidentId: string) => void
  saveTranscript: (text: string) => void
  sendRampRequest: (stopId: string) => void
}
