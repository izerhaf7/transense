import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const storageSource = readFileSync(new URL('./src/plannerStorage.ts', import.meta.url), 'utf8')

const requiredContracts = [
  { label: 'saved stops storage key', value: 'transense.demo-saved-stops.v1', source: storageSource },
  { label: 'search history storage key', value: 'transense.demo-search-history.v1', source: storageSource },
  { label: 'saved stops capacity', value: 'MAX_SAVED_STOPS', source: storageSource },
  { label: 'search history capacity', value: 'MAX_SEARCH_HISTORY', source: storageSource },
]

for (const { label, value, source } of requiredContracts) {
  if (!source.includes(value)) {
    throw new Error(`Missing planner storage contract: ${label} (${value})`)
  }
}

if (storageSource.includes('as any') || storageSource.includes('@ts-ignore') || storageSource.includes('eslint-disable')) {
  throw new Error('Planner storage must not use type suppression.')
}

// Transpile the pure helpers to CommonJS and execute them in a VM sandbox so the
// reducers can be unit-tested without a browser (no DOM, no localStorage).
const transpiled = ts.transpileModule(storageSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
  fileName: 'plannerStorage.ts',
}).outputText

const sandbox = { module: { exports: {} }, exports: {}, console }
vm.createContext(sandbox)
vm.runInContext(transpiled, sandbox, { filename: 'plannerStorage.ts' })

const {
  saveSavedStop,
  removeSavedStop,
  addHistoryEntry,
  savedStopId,
  savedStopFromPoint,
  pointFromSavedStop,
  historyEntryKey,
} = sandbox.exports

const assert = (condition, message) => {
  if (!condition) throw new Error(`Planner storage unit test failed: ${message}`)
}

// savedStopId: stop_id wins; coords are the fallback key.
assert(savedStopId({ stop_id: 'stop-bun', name: 'x', lat: 1, lng: 2 }) === 'stop-bun', 'savedStopId uses stop_id')
assert(savedStopId({ name: 'x', lat: -6.19, lng: 106.82 }) === 'coord:-6.19,106.82', 'savedStopId falls back to coords')

// saveSavedStop: most-recent-first, dedupe by id, cap at 10 with oldest evicted.
const mkStop = (id) => ({ id, name: id, stopName: `Halte ${id}`, lat: 1, lng: 2 })
let stops = []
for (let i = 0; i < 12; i += 1) stops = saveSavedStop(stops, mkStop(`stop-${i}`))
assert(stops.length === 10, `saved stop cap at 10, got ${stops.length}`)
assert(stops[0].id === 'stop-11', 'saved stops most recent first')
assert(!stops.some((s) => s.id === 'stop-0'), 'oldest saved stop evicted')
stops = saveSavedStop(stops, mkStop('stop-5'))
assert(stops.filter((s) => s.id === 'stop-5').length === 1, 'saved stop dedupe by stop id')
assert(stops[0].id === 'stop-5', 'saved stop dedupe moves to top')

// removeSavedStop: individual removal.
stops = removeSavedStop(stops, 'stop-5')
assert(!stops.some((s) => s.id === 'stop-5'), 'remove individual saved stop')

// addHistoryEntry: most-recent-first, cap at 10, consecutive duplicate merged to top.
const originA = { stop_id: 'stop-a', name: 'A', lat: 1, lng: 2 }
const destinationB = { stop_id: 'stop-b', name: 'B', lat: 3, lng: 4 }
let history = []
for (let i = 0; i < 12; i += 1) {
  history = addHistoryEntry(history, {
    origin: { stop_id: `stop-o${i}`, name: `O${i}`, lat: 1, lng: 2 },
    destination: destinationB,
    at: new Date(1700000000000 + i).toISOString(),
  })
}
assert(history.length === 10, `history cap at 10, got ${history.length}`)
assert(history[0].origin.stop_id === 'stop-o11', 'history most recent first')
history = addHistoryEntry(history, { origin: originA, destination: destinationB, at: '2026-01-01T00:00:00.000Z' })
history = addHistoryEntry(history, { origin: originA, destination: destinationB, at: '2026-01-02T00:00:00.000Z' })
const duplicateKey = historyEntryKey({ origin: originA, destination: destinationB, at: '' })
assert(history.filter((entry) => historyEntryKey(entry) === duplicateKey).length === 1, 'consecutive duplicate merged into one entry')
assert(history[0].at === '2026-01-02T00:00:00.000Z', 'duplicate merge moves entry to top')
assert(history[0].origin.stop_id === 'stop-a', 'merged entry keeps the new origin')

// savedStopFromPoint / pointFromSavedStop round-trip.
const fromPoint = savedStopFromPoint({ stop_id: 'stop-kp', name: 'Halte Karet', lat: -6.1943, lng: 106.8218 }, 'Kantor')
assert(fromPoint.id === 'stop-kp' && fromPoint.name === 'Kantor' && fromPoint.stopName === 'Halte Karet', 'savedStopFromPoint shape')
assert(fromPoint.name === 'Kantor' && fromPoint.stopName === 'Halte Karet', 'savedStopFromPoint keeps label + stop name')
const back = pointFromSavedStop(fromPoint)
assert(back.stop_id === 'stop-kp' && back.name === 'Halte Karet' && back.lat === -6.1943, 'pointFromSavedStop restores stop_id')
const coordRoundTrip = pointFromSavedStop({ id: 'coord:-6.19,106.82', name: 'Rumah', stopName: 'Halte X', lat: -6.19, lng: 106.82 })
assert(coordRoundTrip.stop_id === undefined && coordRoundTrip.name === 'Halte X', 'coord saved stops produce a coordinate point')

console.log('Planner storage deterministic checks passed: keys present, reducers behave (dedupe, cap, order).')
