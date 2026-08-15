import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/SideBySidePage.tsx', import.meta.url), 'utf8')

// (b) Source contracts: facilities endpoint, TTS speak usage, and the two
// profile renderers must stay present.
const requiredContracts = [
  { label: 'facilities endpoint', value: 'api/facilities/stops', source },
  { label: 'tts speak usage', value: 'tts.speak', source },
  { label: 'daksa visual branch', value: "profile === 'daksa'", source },
  { label: 'netra verbal branch', value: 'sbs-speak-button', source },
  { label: 'announcement text twin', value: 'sbs-announcement', source },
  { label: 'announcement builder', value: 'buildStopAnnouncement', source },
  { label: 'type guard', value: 'isFacilityStop', source },
]

for (const { label, value, source: target } of requiredContracts) {
  if (!target.includes(value)) {
    throw new Error(`Missing SideBySidePage contract: ${label} (${value})`)
  }
}

// (c) Strict TS: no type suppression in the component.
if (source.includes('as any') || source.includes('@ts-ignore') || source.includes('eslint-disable')) {
  throw new Error('SideBySidePage.tsx must not use type suppression.')
}

// (d) Override compliance (brief-v2): facility data is normal data. The
// component must never present simulated badges/labels on facility data.
if (source.includes('simulated')) {
  throw new Error('SideBySidePage.tsx must not contain a "simulated" label string (brief-v2 override).')
}

// Transpile TSX to CommonJS and run in a VM sandbox with stubbed React so the
// pure `buildStopAnnouncement` is unit-testable without a browser.
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
  },
  fileName: 'SideBySidePage.tsx',
}).outputText

// Lightweight React stubs: the module only needs them at import time, the pure
// functions under test never render.
const reactStub = {
  useEffect: () => {},
  useState: () => [],
  Fragment: ({ children }) => children,
}
const jsxRuntimeStub = { jsx: () => null, jsxs: () => null, Fragment: () => null }

const mod = { exports: {} }
const sandbox = {
  module: mod,
  exports: mod.exports,
  console,
  require: (specifier) => {
    if (specifier === 'react') return reactStub
    if (specifier === 'react/jsx-runtime') return jsxRuntimeStub
    throw new Error(`Unexpected require from SideBySidePage.tsx: ${specifier}`)
  },
}
vm.createContext(sandbox)
vm.runInContext(transpiled, sandbox, { filename: 'SideBySidePage.tsx' })

const { buildStopAnnouncement } = mod.exports

const assert = (condition, message) => {
  if (!condition) throw new Error(`SideBySidePage unit test failed: ${message}`)
}

const fullStop = {
  id: 'fac-bundaran-hi',
  name: 'Bundaran HI',
  lat: -6.1946,
  lng: 106.8231,
  facilities: {
    ramp: true,
    lift: true,
    toilet_accessible: true,
    guiding_block: true,
    staffed: true,
    step_free_access: true,
  },
}

// (a) The announcement includes the stop name and the available facilities in Indonesian.
const fullAnnouncement = buildStopAnnouncement(fullStop)
assert(fullAnnouncement.includes('Bundaran HI'), `announcement names the stop (got "${fullAnnouncement}")`)
for (const facility of ['ramp', 'lift', 'toilet aksesibel', 'guiding block', 'staf', 'akses tanpa langkah']) {
  assert(fullAnnouncement.includes(facility), `announcement lists "${facility}" when available (got "${fullAnnouncement}")`)
}

// Only available facilities are mentioned; unavailable ones are never read out.
const partialStop = {
  id: 'fac-kota-tua',
  name: 'Kota Tua',
  lat: -6.1352,
  lng: 106.8133,
  facilities: {
    ramp: true,
    lift: false,
    toilet_accessible: true,
    guiding_block: true,
    staffed: true,
    step_free_access: false,
  },
}
const partialAnnouncement = buildStopAnnouncement(partialStop)
assert(partialAnnouncement.includes('Kota Tua'), 'announcement names the partial stop')
assert(partialAnnouncement.includes('ramp'), 'partial announcement keeps available ramp')
assert(partialAnnouncement.includes('guiding block'), 'partial announcement keeps available guiding block')
assert(!partialAnnouncement.includes('lift'), `partial announcement must not mention unavailable lift (got "${partialAnnouncement}")`)
assert(!partialAnnouncement.includes('tanpa langkah'), 'partial announcement must not mention unavailable step-free access')

// Determinism: same input always yields byte-identical output.
assert(buildStopAnnouncement(fullStop) === fullAnnouncement, 'announcement is deterministic')

// No-facility stop produces a clear Indonesian fallback instead of an empty list.
const bareStop = {
  ...fullStop,
  id: 'fac-bare',
  name: 'Halte Tanpa Fasilitas',
  facilities: {
    ramp: false,
    lift: false,
    toilet_accessible: false,
    guiding_block: false,
    staffed: false,
    step_free_access: false,
  },
}
const bareAnnouncement = buildStopAnnouncement(bareStop)
assert(bareAnnouncement.includes('Halte Tanpa Fasilitas'), 'bare announcement names the stop')
assert(!bareAnnouncement.includes('Tersedia '), `bare announcement must not say "Tersedia" with an empty list (got "${bareAnnouncement}")`)

console.log('SideBySidePage deterministic checks passed: endpoint contract, dual renderers, Indonesian announcement, no type suppression, no simulated labels.')
