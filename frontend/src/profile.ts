/**
 * Local persistence for the demo profile: display name + accessibility profile
 * type (the "profil model v2" shape). PURE FRONTEND — localStorage only.
 *
 * v1 stored only `{ displayName, createdAt }` under `transense.demo-profile.v1`.
 * v2 adds the `profile` field (`ProfileType`) under `transense.demo-profile.v2`.
 * `readProfile` silently migrates a v1 record on first read — it writes the v2
 * record and leaves the v1 key intact (non-destructive). Unknown `profile`
 * values fall back to the historical default `'tuli'` instead of crashing.
 *
 * The pure helpers (`normalizeProfile`, `normalizeProfileType`, `isProfileType`)
 * are exported so the storage layer can be unit-tested without a browser (see
 * profile-storage-check.mjs); the `window.localStorage` wrappers only run inside
 * the browser, mirroring the plannerStorage.ts pattern.
 */

export type ProfileType = 'tuli' | 'netra' | 'daksa'

export type OutputChannel = 'visual' | 'haptic' | 'audio' | 'auto'

export interface DemoProfile {
  displayName: string
  profile: ProfileType
  createdAt: string
  /** Preferred notification output channel; missing/unknown values default to 'auto'. */
  outputChannel?: OutputChannel
}

export const PROFILE_STORAGE_KEY_V1 = 'transense.demo-profile.v1'
export const PROFILE_STORAGE_KEY_V2 = 'transense.demo-profile.v2'

const PROFILE_TYPES = ['tuli', 'netra', 'daksa'] as const
const OUTPUT_CHANNELS = ['visual', 'haptic', 'audio', 'auto'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isProfileType(value: unknown): value is ProfileType {
  return typeof value === 'string' && (PROFILE_TYPES as readonly string[]).includes(value)
}

export function isOutputChannel(value: unknown): value is OutputChannel {
  return typeof value === 'string' && (OUTPUT_CHANNELS as readonly string[]).includes(value)
}

/** Unknown/missing profile values fall back to the historical default. */
export function normalizeProfileType(value: unknown): ProfileType {
  return isProfileType(value) ? value : 'tuli'
}

/** Unknown/missing output channel values fall back to the automatic default. */
export function normalizeOutputChannel(value: unknown): OutputChannel {
  return isOutputChannel(value) ? value : 'auto'
}

/**
 * Validate + normalize an unknown parsed profile value. Returns null for
 * non-records, missing/blank display names, and corrupt payloads that callers
 * could not parse; otherwise produces a complete DemoProfile with a valid type.
 */
export function normalizeProfile(value: unknown): DemoProfile | null {
  if (!isRecord(value) || typeof value.displayName !== 'string') {
    return null
  }

  const displayName = value.displayName.trim()
  if (!displayName) {
    return null
  }

  return {
    displayName,
    profile: normalizeProfileType(value.profile),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    outputChannel: normalizeOutputChannel(value.outputChannel),
  }
}

export function readProfile(): DemoProfile | null {
  try {
    const storedV2 = window.localStorage.getItem(PROFILE_STORAGE_KEY_V2)
    if (storedV2) {
      return normalizeProfile(JSON.parse(storedV2))
    }

    const storedV1 = window.localStorage.getItem(PROFILE_STORAGE_KEY_V1)
    if (storedV1) {
      const migrated = normalizeProfile(JSON.parse(storedV1))
      if (migrated) {
        // Silent, non-destructive migration: write v2 and keep v1 intact.
        window.localStorage.setItem(PROFILE_STORAGE_KEY_V2, JSON.stringify(migrated))
      }
      return migrated
    }

    return null
  } catch (error: unknown) {
    console.warn('Transense could not read the local demo profile.', error)
    return null
  }
}

export function persistProfile(profile: DemoProfile): boolean {
  try {
    window.localStorage.setItem(PROFILE_STORAGE_KEY_V2, JSON.stringify(profile))
    return true
  } catch (error: unknown) {
    console.warn('Transense could not save the local demo profile.', error)
    return false
  }
}

export function clearStoredProfile(): boolean {
  try {
    window.localStorage.removeItem(PROFILE_STORAGE_KEY_V2)
    window.localStorage.removeItem(PROFILE_STORAGE_KEY_V1)
    return true
  } catch (error: unknown) {
    console.warn('Transense could not clear the local demo profile.', error)
    return false
  }
}
