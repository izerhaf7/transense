import { readFileSync } from 'node:fs'

const plannerSource = readFileSync(new URL('./src/PlannerPage.tsx', import.meta.url), 'utf8')
const trackingSource = readFileSync(new URL('./src/TransitTrackingPage.tsx', import.meta.url), 'utf8')
const mapSource = readFileSync(new URL('./src/MapboxMap.tsx', import.meta.url), 'utf8')
const storageSource = readFileSync(new URL('./src/plannerStorage.ts', import.meta.url), 'utf8')

const requiredContracts = [
  { label: 'plan endpoint call', value: '/api/journey/plan', source: plannerSource },
  { label: 'itineraries collection', value: 'itineraries', source: plannerSource },
  { label: 'walk leg detection', value: "mode === 'WALK'", source: plannerSource },
  { label: 'bus leg detection', value: "mode === 'BUS'", source: plannerSource },
  { label: 'stop search endpoint', value: '/api/gtfs/stops/search', source: plannerSource },
  { label: 'route shape endpoint', value: '/api/gtfs/route/', source: plannerSource },
  { label: 'plan unavailable label', value: "source: 'gtfs' | 'unavailable'", source: plannerSource },
  { label: 'plan degraded detection', value: "source === 'unavailable'", source: plannerSource },
  { label: 'tracking endpoint reuse', value: '/api/journey/track', source: trackingSource },
  { label: 'walk leg polyline support', value: 'walk-', source: mapSource },
  // Moovit-style additions (trip-planner-moovit): arrive-by, ETA, incidents, saved places/history
  // Upstream (jis-blokm-auto-simulation) split departure/arrival into independent fields:
  //   `if (departure) params.set('time', departure)` and `if (arrival) params.set('arrive_by', arrival)`.
  { label: 'arrive-by query param', value: "params.set('arrive_by', arrival)", source: plannerSource },
  { label: 'include-eta query param', value: "params.set('include_eta', '1')", source: plannerSource },
  { label: 'departure time query param', value: "params.set('time', departure)", source: plannerSource },
  { label: 'per-leg delay field', value: 'delay_minutes', source: plannerSource },
  { label: 'eta source field', value: 'eta_source', source: plannerSource },
  { label: 'plan incidents field', value: 'incidents', source: plannerSource },
  { label: 'delay status label', value: 'Keterlambatan', source: plannerSource },
  { label: 'diverted status label', value: 'Pengalihan', source: plannerSource },
  { label: 'simulated eta label', value: 'simulasi', source: plannerSource },
  { label: 'affected leg chip', value: 'terganggu', source: plannerSource },
  { label: 'arrive-by toggle label', value: 'Tiba jam', source: plannerSource },
  { label: 'departure toggle label', value: 'Berangkat jam', source: plannerSource },
  { label: 'saved stops storage key', value: 'transense.demo-saved-stops.v1', source: storageSource },
  { label: 'search history storage key', value: 'transense.demo-search-history.v1', source: storageSource },
]

for (const { label, value, source } of requiredContracts) {
  if (!source.includes(value)) {
    throw new Error(`Missing planner frontend contract: ${label} (${value})`)
  }
}

for (const source of [plannerSource, trackingSource, mapSource, storageSource]) {
  if (source.includes('as any') || source.includes('@ts-ignore') || source.includes('eslint-disable')) {
    throw new Error('Planner frontend must not use type suppression.')
  }
}

console.log('Planner deterministic checks passed: plan + itinerary + leg + Moovit (arrive-by/ETA/incidents/saved) contracts present, no type suppression.')
