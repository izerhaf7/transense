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
  { label: 'panorama lookup', value: 'getPanoramaConfig', source },
  { label: 'panorama renderer', value: 'PanoramaFacilities', source },
  { label: 'panorama fallback placeholder', value: 'sbs-stop-card__visual', source },
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

// Lightweight React stubs: the module only needs them at import time, the pure
// functions under test never render. The panorama modules are also imported by
// SideBySidePage: the pure config is evaluated for real; the React component
// is stubbed because it only renders in a browser.
const reactStub = {
  useEffect: () => {},
  useState: () => [],
  Fragment: ({ children }) => children,
}
const jsxRuntimeStub = { jsx: () => null, jsxs: () => null, Fragment: () => null }

const transpileToCommonJs = (sourceText, fileName) =>
  ts.transpileModule(sourceText, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName,
  }).outputText

const evaluateModule = (sourceText, fileName, extraSandbox = {}) => {
  const moduleRecord = { exports: {} }
  const sandbox = {
    module: moduleRecord,
    exports: moduleRecord.exports,
    console,
    require: (specifier) => {
      if (specifier === 'react') return reactStub
      if (specifier === 'react/jsx-runtime') return jsxRuntimeStub
      if (specifier === './PanoramaFacilities') return { default: () => null }
      if (specifier === './panoramaConfig') return panoramaConfigModule.exports
      return extraSandbox.require?.(specifier)
    },
    ...extraSandbox,
  }
  vm.createContext(sandbox)
  vm.runInContext(transpileToCommonJs(sourceText, fileName), sandbox, { fileName })
  return moduleRecord
}

// Real panorama config module: pure data + lookup, safe to evaluate in node.
const panoramaSource = readFileSync(new URL('./src/panoramaConfig.ts', import.meta.url), 'utf8')
const panoramaConfigModule = evaluateModule(panoramaSource, 'panoramaConfig.ts')

const mod = evaluateModule(source, 'SideBySidePage.tsx')

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

// (e) Panorama config: annotated stops resolve, unannotated stops fall back to
// the placeholder, and every chip yaw is a valid 0..360 degree heading.
const { getPanoramaConfig } = panoramaConfigModule.exports

const bundaranHi = getPanoramaConfig('fac-bundaran-hi')
assert(bundaranHi !== null, 'bundaran-hi stop has a panorama config')
assert(bundaranHi.imageUrl === '/panorama/bundaran-hi.jpg', 'bundaran-hi panorama image path is correct')

const senayan = getPanoramaConfig('fac-senayan')
assert(senayan !== null, 'senayan stop has a panorama config')
assert(senayan.imageUrl === '/panorama/senayan.jpg', 'senayan panorama image path is correct')

assert(getPanoramaConfig('fac-kota-tua') === null, 'unannotated stops return null (placeholder fallback)')
assert(getPanoramaConfig('unknown-stop') === null, 'unknown stop ids return null')

for (const config of [bundaranHi, senayan]) {
  assert(config.stopId.length > 0, 'panorama config carries its stop id')
  for (const chip of config.chips) {
    assert(typeof chip.facility === 'string' && chip.facility !== '', 'panorama chip facility key is a non-empty string')
    assert(chip.yaw >= 0 && chip.yaw <= 360, `panorama chip yaw must be 0..360 degrees (got ${chip.yaw})`)
  }
}

console.log('SideBySidePage deterministic checks passed: endpoint contract, dual renderers, Indonesian announcement, panorama config, no type suppression, no simulated labels.')
