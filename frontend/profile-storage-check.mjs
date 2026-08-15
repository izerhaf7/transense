import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const profileSource = readFileSync(new URL('./src/profile.ts', import.meta.url), 'utf8')

const requiredContracts = [
  { label: 'v2 storage key', value: 'transense.demo-profile.v2', source: profileSource },
  { label: 'v1 storage key (non-destructive migration source)', value: 'transense.demo-profile.v1', source: profileSource },
]

for (const { label, value, source } of requiredContracts) {
  if (!source.includes(value)) {
    throw new Error(`Missing profile storage contract: ${label} (${value})`)
  }
}

if (profileSource.includes('as any') || profileSource.includes('@ts-ignore') || profileSource.includes('eslint-disable')) {
  throw new Error('Profile storage must not use type suppression.')
}

// Transpile the storage helpers to CommonJS and execute them in a VM sandbox with
// a fake `window.localStorage` so read/persist/clear can be unit-tested without a
// browser (no DOM), mirroring planner-storage-check.mjs.
const transpiled = ts.transpileModule(profileSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
  fileName: 'profile.ts',
}).outputText

const storage = new Map()
const sandbox = {
  module: { exports: {} },
  exports: {},
  console,
  window: {
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => {
        storage.set(key, String(value))
      },
      removeItem: (key) => {
        storage.delete(key)
      },
    },
  },
}
vm.createContext(sandbox)
vm.runInContext(transpiled, sandbox, { filename: 'profile.ts' })

const {
  readProfile,
  persistProfile,
  clearStoredProfile,
  normalizeProfile,
  normalizeProfileType,
  PROFILE_STORAGE_KEY_V1,
  PROFILE_STORAGE_KEY_V2,
} = sandbox.exports

const assert = (condition, message) => {
  if (!condition) throw new Error(`Profile storage unit test failed: ${message}`)
}

const V1_PROFILE = JSON.stringify({ displayName: 'Dita', createdAt: '2026-01-01T00:00:00.000Z' })

// Migration: v2 absent, v1 present -> v2 with profile 'tuli', displayName/createdAt preserved,
// v1 key left intact (non-destructive).
storage.clear()
storage.set(PROFILE_STORAGE_KEY_V1, V1_PROFILE)
assert(!storage.has(PROFILE_STORAGE_KEY_V2), 'no v2 key before migration')
const migrated = readProfile()
assert(migrated !== null, 'v1 migration returns a profile')
assert(migrated.displayName === 'Dita', 'migration preserves displayName')
assert(migrated.createdAt === '2026-01-01T00:00:00.000Z', 'migration preserves createdAt')
assert(migrated.profile === 'tuli', 'migration defaults profile to tuli')
assert(storage.has(PROFILE_STORAGE_KEY_V2), 'migration writes the v2 key')
assert(storage.get(PROFILE_STORAGE_KEY_V1) === V1_PROFILE, 'migration keeps the v1 key intact')
const reread = readProfile()
assert(reread !== null && reread.profile === 'tuli', 're-read uses the migrated v2 record')

// Unknown profile value 'xyz' -> 'tuli', no crash.
storage.clear()
storage.set(PROFILE_STORAGE_KEY_V2, JSON.stringify({ displayName: 'Dita', profile: 'xyz', createdAt: '2026-01-01T00:00:00.000Z' }))
const unknownType = readProfile()
assert(unknownType !== null && unknownType.profile === 'tuli', 'unknown profile value falls back to tuli')
assert(normalizeProfileType('netra') === 'netra', 'normalizeProfileType keeps known types')
assert(normalizeProfileType('xyz') === 'tuli' && normalizeProfileType(undefined) === 'tuli', 'normalizeProfileType defaults unknown/missing values')
assert(normalizeProfile({ displayName: 'Budi', profile: 'daksa', createdAt: 'x' })?.profile === 'daksa', 'normalizeProfile preserves valid v2 type')

// Corrupt JSON -> null.
storage.clear()
storage.set(PROFILE_STORAGE_KEY_V2, '{not valid json')
assert(readProfile() === null, 'corrupt v2 JSON returns null')
storage.clear()
storage.set(PROFILE_STORAGE_KEY_V1, '{also not json')
assert(readProfile() === null, 'corrupt v1 JSON returns null (no v2 fallback)')

// Missing/invalid shapes -> null.
storage.clear()
assert(readProfile() === null, 'no stored profile returns null')
assert(normalizeProfile(null) === null, 'normalizeProfile rejects non-record input')
assert(normalizeProfile({ createdAt: '2026-01-01T00:00:00.000Z' }) === null, 'normalizeProfile rejects missing displayName')
assert(normalizeProfile({ displayName: '   ' }) === null, 'normalizeProfile rejects blank displayName')

// Round-trip persist -> read.
storage.clear()
const createdAt = '2026-02-01T00:00:00.000Z'
assert(persistProfile({ displayName: 'Budi', profile: 'netra', createdAt }) === true, 'persistProfile returns true')
const roundTrip = readProfile()
assert(roundTrip !== null, 'persisted profile reads back')
assert(roundTrip.displayName === 'Budi' && roundTrip.profile === 'netra' && roundTrip.createdAt === createdAt, 'persist->read round-trip preserves all fields')

// clearStoredProfile removes both v1 and v2 keys.
storage.set(PROFILE_STORAGE_KEY_V1, V1_PROFILE)
storage.set(PROFILE_STORAGE_KEY_V2, JSON.stringify({ displayName: 'Budi', profile: 'netra', createdAt }))
assert(clearStoredProfile() === true, 'clearStoredProfile returns true')
assert(!storage.has(PROFILE_STORAGE_KEY_V1) && !storage.has(PROFILE_STORAGE_KEY_V2), 'clearStoredProfile removes v1 and v2 keys')

console.log('Profile storage deterministic checks passed: v1->v2 migration, type fallback, corruption handling, round-trip.')
