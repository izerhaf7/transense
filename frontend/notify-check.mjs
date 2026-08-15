import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const notifySource = readFileSync(new URL('./src/notify.ts', import.meta.url), 'utf8')

const requiredContracts = [
  { label: 'per-profile resolver', value: 'resolveNotificationOutput', source: notifySource },
  { label: 'dedupe guard', value: 'shouldSpeakNotification', source: notifySource },
  { label: 'banner modifier helper', value: 'notificationModifierClass', source: notifySource },
]

for (const { label, value, source } of requiredContracts) {
  if (!source.includes(value)) {
    throw new Error(`Missing notification contract: ${label} (${value})`)
  }
}

if (notifySource.includes('as any') || notifySource.includes('@ts-ignore') || notifySource.includes('eslint-disable')) {
  throw new Error('notify.ts must not use type suppression.')
}

// Vibration patterns must come from journey.ts (the contract owner), never be
// redefined here. Literal pattern arrays inside notify.ts would mean drift.
for (const literal of ['[200, 100, 200]', '[300, 100, 300, 100, 300]', '[500, 200, 500, 200, 1000]']) {
  if (notifySource.includes(literal)) {
    throw new Error(`notify.ts must not redefine vibration patterns (found ${literal}) — import VIBRATION_PATTERNS instead.`)
  }
}

const transpileToCjs = (source, fileName) =>
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName,
  }).outputText

// Load journey.ts and profile.ts as real CommonJS modules in the sandbox so the
// notify.ts `require('./journey')` / `require('./profile')` resolve without a browser.
const loadModule = (source, fileName) => {
  const mod = { exports: {} }
  const sandbox = { module: mod, exports: mod.exports, console }
  vm.createContext(sandbox)
  vm.runInContext(transpileToCjs(source, fileName), sandbox, { filename: fileName })
  return mod.exports
}

const journey = loadModule(readFileSync(new URL('./src/journey.ts', import.meta.url), 'utf8'), 'journey.ts')
const profile = loadModule(readFileSync(new URL('./src/profile.ts', import.meta.url), 'utf8'), 'profile.ts')

const notifyMod = { exports: {} }
const notifySandbox = {
  module: notifyMod,
  exports: notifyMod.exports,
  console,
  require: (specifier) => {
    if (specifier === './journey') return journey
    if (specifier === './profile') return profile
    throw new Error(`Unexpected require from notify.ts: ${specifier}`)
  },
}
vm.createContext(notifySandbox)
vm.runInContext(transpileToCjs(notifySource, 'notify.ts'), notifySandbox, { filename: 'notify.ts' })

const { resolveNotificationOutput, shouldSpeakNotification, notificationModifierClass } = notifyMod.exports

const assert = (condition, message) => {
  if (!condition) throw new Error(`Notification unit test failed: ${message}`)
}

const samePattern = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index])

const vehicleRecord = {
  id: 'evt-1',
  kind: 'vehicle_approaching',
  title: 'Armada Mendekat',
  message: 'Bus Koridor 1 tiba dalam 2 menit.',
}
const destinationRecord = {
  id: 'evt-2',
  kind: 'destination_approaching',
  title: 'Halte Tujuan Dekat',
  message: 'Segera siap turun di Halte Bundaran HI.',
}
const incidentRecord = {
  id: 'evt-3',
  kind: 'incident',
  title: 'Gangguan Layanan',
  message: 'Perjalanan koridor 1 mengalami penundaan.',
}
const offRouteRecord = {
  id: 'evt-4',
  kind: 'off_route',
  title: 'Di Luar Rute',
  message: 'Simulasi debug tanpa geolocation.',
}

// (a) tuli (default): vibration called, TTS NOT called, byte-identical banner.
const tuliVehicle = resolveNotificationOutput('tuli', vehicleRecord)
assert(tuliVehicle.speakText === null, 'tuli must never speak (speakText null)')
assert(samePattern(tuliVehicle.vibratePattern, journey.VIBRATION_PATTERNS.vehicleApproaching), 'tuli vibrates with the journey pattern')
assert(tuliVehicle.renderMode === 'standard', 'tuli uses the standard banner mode')
assert(notificationModifierClass(tuliVehicle.renderMode) === '', 'tuli banner modifier is empty (no class change)')

// (b) netra: TTS speaks title+message, vibrates, banner uses the netra (text twin) mode.
const netraIncident = resolveNotificationOutput('netra', incidentRecord)
assert(netraIncident.speakText === 'Gangguan Layanan. Perjalanan koridor 1 mengalami penundaan.', `netra speaks title+message (got "${netraIncident.speakText}")`)
assert(samePattern(netraIncident.vibratePattern, journey.VIBRATION_PATTERNS.incident), 'netra vibrates with the kind pattern')
assert(netraIncident.renderMode === 'netra', 'netra uses the netra banner mode')
assert(notificationModifierClass(netraIncident.renderMode) === ' notification-banner--netra', 'netra banner carries the text-twin modifier class')

// (c) daksa: vibration called, no TTS, larger-text banner mode.
const daksaDestination = resolveNotificationOutput('daksa', destinationRecord)
assert(daksaDestination.speakText === null, 'daksa must never speak (speakText null)')
assert(samePattern(daksaDestination.vibratePattern, journey.VIBRATION_PATTERNS.destinationApproaching), 'daksa vibrates with the kind pattern')
assert(daksaDestination.renderMode === 'daksa', 'daksa uses the larger-text banner mode')
assert(notificationModifierClass(daksaDestination.renderMode) === ' notification-banner--daksa', 'daksa banner carries the larger-text modifier class')

// (d) off_route never vibrates, for any profile.
for (const profileType of ['tuli', 'netra', 'daksa']) {
  const offRouteOutput = resolveNotificationOutput(profileType, offRouteRecord)
  assert(offRouteOutput.vibratePattern === null, `off_route must not vibrate for ${profileType}`)
}

// (e) netra must NOT re-speak the same notification id twice.
assert(shouldSpeakNotification('netra', incidentRecord, null) === true, 'netra speaks a brand-new notification')
assert(shouldSpeakNotification('netra', incidentRecord, 'evt-3') === false, 'netra does not re-speak the same id')
assert(shouldSpeakNotification('netra', destinationRecord, 'evt-3') === true, 'netra speaks again when a different id arrives')
assert(shouldSpeakNotification('tuli', incidentRecord, null) === false, 'tuli never speaks')
assert(shouldSpeakNotification('daksa', incidentRecord, null) === false, 'daksa never speaks')

// (f) the three documented patterns stay distinct and come from journey.
assert(samePattern(journey.VIBRATION_PATTERNS.vehicleApproaching, [200, 100, 200]), 'journey vehicle pattern intact')
assert(samePattern(journey.VIBRATION_PATTERNS.destinationApproaching, [300, 100, 300, 100, 300]), 'journey destination pattern intact')
assert(samePattern(journey.VIBRATION_PATTERNS.incident, [500, 200, 500, 200, 1000]), 'journey incident pattern intact')

console.log('Notification deterministic checks passed: per-profile resolution, TTS dedupe, no pattern drift.')
