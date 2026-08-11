export interface Stop {
  id: string
  name: string
}

export interface Route {
  id: string
  name: string
  stop_ids: string[]
}

export interface Trip {
  id: string
  route_id: string
  vehicle_id: string
}

export interface Vehicle {
  id: string
  trip_id: string
  position: string
  eta_minutes: number
}

export interface Eta {
  id: string
  vehicle_id: string
  stop_id: string
  minutes: number
}

export interface Incident {
  id: string
  route_id: string
  status: string
  message: string
  cause?: string
  action?: string
  instruction?: string
  updated_at?: string
}

export interface TransitState {
  stops: Stop[]
  routes: Route[]
  trips: Trip[]
  vehicles: Vehicle[]
  etas: Eta[]
  incidents: Incident[]
}

export const VIBRATION_PATTERNS = {
  vehicleApproaching: [200, 100, 200],
  destinationApproaching: [300, 100, 300, 100, 300],
  incident: [500, 200, 500, 200, 1000],
} as const

export const SEEDED_TRANSIT_STATE: TransitState = {
  stops: [
    { id: 'stop-kp', name: 'Halte Karet' },
    { id: 'stop-bun', name: 'Halte Bundaran HI' },
  ],
  routes: [{ id: 'route-1', name: 'Koridor 1', stop_ids: ['stop-kp', 'stop-bun'] }],
  trips: [{ id: 'trip-1', route_id: 'route-1', vehicle_id: 'vehicle-kp-01' }],
  vehicles: [{ id: 'vehicle-kp-01', trip_id: 'trip-1', position: 'stop-kp', eta_minutes: 4 }],
  etas: [{ id: 'eta-vehicle-kp-01', vehicle_id: 'vehicle-kp-01', stop_id: 'stop-bun', minutes: 4 }],
  incidents: [{
    id: 'incident-demo-01',
    route_id: 'route-1',
    status: 'normal',
    message: 'Layanan berjalan normal',
    cause: 'Tidak ada gangguan pada simulasi seed.',
    action: 'Layanan berjalan sesuai skenario demo.',
    instruction: 'Tetap lihat pembaruan visual di aplikasi.',
    updated_at: '2026-08-11T08:00:00Z',
  }],
}

export function cloneTransitState(state: TransitState): TransitState {
  return {
    stops: state.stops.map((stop) => ({ ...stop })),
    routes: state.routes.map((route) => ({ ...route, stop_ids: [...route.stop_ids] })),
    trips: state.trips.map((trip) => ({ ...trip })),
    vehicles: state.vehicles.map((vehicle) => ({ ...vehicle })),
    etas: state.etas.map((eta) => ({ ...eta })),
    incidents: state.incidents.map((incident) => ({ ...incident })),
  }
}

export function matchSeededStop(state: TransitState, query: string): Stop | null {
  const normalizedQuery = query.trim().toLocaleLowerCase('id-ID')
  if (!normalizedQuery) {
    return null
  }

  return state.stops.find((stop) => stop.name.toLocaleLowerCase('id-ID').includes(normalizedQuery)) || null
}

export function findRouteBetweenStops(state: TransitState, originId: string, destinationId: string): Route | null {
  return state.routes.find((route) => {
    const originIndex = route.stop_ids.indexOf(originId)
    const destinationIndex = route.stop_ids.indexOf(destinationId)
    return originIndex >= 0 && destinationIndex > originIndex
  }) || null
}

export function areVibrationPatternsDistinct(): boolean {
  const patterns = Object.values(VIBRATION_PATTERNS).map((pattern) => pattern.join(','))
  return new Set(patterns).size === patterns.length
}
