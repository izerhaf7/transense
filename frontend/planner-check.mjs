import { readFileSync } from 'node:fs'

const plannerSource = readFileSync(new URL('./src/PlannerPage.tsx', import.meta.url), 'utf8')
const trackingSource = readFileSync(new URL('./src/TransitTrackingPage.tsx', import.meta.url), 'utf8')
const mapSource = readFileSync(new URL('./src/MapboxMap.tsx', import.meta.url), 'utf8')

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
]

for (const { label, value, source } of requiredContracts) {
  if (!source.includes(value)) {
    throw new Error(`Missing planner frontend contract: ${label} (${value})`)
  }
}

for (const source of [plannerSource, trackingSource, mapSource]) {
  if (source.includes('as any') || source.includes('@ts-ignore') || source.includes('eslint-disable')) {
    throw new Error('Planner frontend must not use type suppression.')
  }
}

console.log('Planner deterministic checks passed: plan + itinerary + leg contracts present, no type suppression.')
