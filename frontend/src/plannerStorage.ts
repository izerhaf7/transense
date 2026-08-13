/**
 * Local persistence for the trip planner: saved places ("halte favorit") and
 * recent search history ("riwayat pencarian"). PURE FRONTEND — localStorage only.
 *
 * Storage keys follow the existing `transense.demo-profile.v1` convention and the
 * try/catch read/write pattern from App.tsx (`readProfile` / `persistProfile`).
 *
 * The pure reducer helpers (`saveSavedStop`, `addHistoryEntry`, ...) are exported
 * so they can be unit-tested without a browser (see planner-storage-check.mjs);
 * the `window.localStorage` wrappers only run inside the browser.
 */

export interface PlanPoint {
  stop_id?: string
  name: string
  lat: number
  lng: number
}

export interface SavedStop {
  /** Identity key: `stop_id` when the point came from a stop search, otherwise `coord:<lat>,<lng>`. */
  id: string
  /** User-provided label; falls back to the stop name. */
  name: string
  /** The actual stop name, shown as a secondary line when it differs from `name`. */
  stopName: string
  lat: number
  lng: number
}

export interface SearchHistoryEntry {
  origin: PlanPoint
  destination: PlanPoint
  /** ISO timestamp of the successful plan request (HTTP 200). */
  at: string
}

export const SAVED_STOPS_STORAGE_KEY = 'transense.demo-saved-stops.v1'
export const SEARCH_HISTORY_STORAGE_KEY = 'transense.demo-search-history.v1'
export const MAX_SAVED_STOPS = 10
export const MAX_SEARCH_HISTORY = 10

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isPlanPoint(value: unknown): value is PlanPoint {
  if (!isRecord(value)) return false
  return typeof value.name === 'string'
    && typeof value.lat === 'number'
    && typeof value.lng === 'number'
    && (value.stop_id === undefined || typeof value.stop_id === 'string')
}

export function isSavedStop(value: unknown): value is SavedStop {
  if (!isRecord(value)) return false
  return typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.stopName === 'string'
    && typeof value.lat === 'number'
    && typeof value.lng === 'number'
}

export function isSearchHistoryEntry(value: unknown): value is SearchHistoryEntry {
  if (!isRecord(value)) return false
  return isPlanPoint(value.origin)
    && isPlanPoint(value.destination)
    && typeof value.at === 'string'
    && !Number.isNaN(Date.parse(value.at))
}

/** Stable identity key for a planner point: stop_id, or coordinates when no stop_id exists. */
export function savedStopId(point: PlanPoint): string {
  return point.stop_id ?? `coord:${point.lat},${point.lng}`
}

/** Dedupe key for a history entry: JSON of the origin + destination identity keys. */
export function historyEntryKey(entry: SearchHistoryEntry): string {
  return JSON.stringify([savedStopId(entry.origin), savedStopId(entry.destination)])
}

export function savedStopFromPoint(point: PlanPoint, name: string): SavedStop {
  return {
    id: savedStopId(point),
    name: name.trim() || point.name,
    stopName: point.name,
    lat: point.lat,
    lng: point.lng,
  }
}

/** Rebuild a PlanPoint from a SavedStop (id holds the stop_id unless it is a coord key). */
export function pointFromSavedStop(stop: SavedStop): PlanPoint {
  const point: PlanPoint = { name: stop.stopName, lat: stop.lat, lng: stop.lng }
  if (!stop.id.startsWith('coord:')) {
    point.stop_id = stop.id
  }
  return point
}

/** Most-recent-first, deduped by stop id, capped at MAX_SAVED_STOPS (oldest evicted). */
export function saveSavedStop(list: SavedStop[], item: SavedStop): SavedStop[] {
  const next = [item, ...list.filter((existing) => existing.id !== item.id)]
  return next.slice(0, MAX_SAVED_STOPS)
}

export function removeSavedStop(list: SavedStop[], id: string): SavedStop[] {
  return list.filter((existing) => existing.id !== id)
}

/** Most-recent-first; a duplicate route is merged into one entry and moved to the top; capped at MAX_SEARCH_HISTORY. */
export function addHistoryEntry(list: SearchHistoryEntry[], entry: SearchHistoryEntry): SearchHistoryEntry[] {
  const key = historyEntryKey(entry)
  const next = [entry, ...list.filter((existing) => historyEntryKey(existing) !== key)]
  return next.slice(0, MAX_SEARCH_HISTORY)
}

export function removeHistoryEntry(list: SearchHistoryEntry[], at: string): SearchHistoryEntry[] {
  return list.filter((existing) => existing.at !== at)
}

export function readSavedStops(): SavedStop[] {
  try {
    const stored = window.localStorage.getItem(SAVED_STOPS_STORAGE_KEY)
    if (!stored) return []
    const parsed: unknown = JSON.parse(stored)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isSavedStop).slice(0, MAX_SAVED_STOPS)
  } catch (error: unknown) {
    console.warn('Transense could not read the local saved stops.', error)
    return []
  }
}

export function persistSavedStops(stops: SavedStop[]): boolean {
  try {
    window.localStorage.setItem(SAVED_STOPS_STORAGE_KEY, JSON.stringify(stops))
    return true
  } catch (error: unknown) {
    console.warn('Transense could not save the local saved stops.', error)
    return false
  }
}

export function readSearchHistory(): SearchHistoryEntry[] {
  try {
    const stored = window.localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY)
    if (!stored) return []
    const parsed: unknown = JSON.parse(stored)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isSearchHistoryEntry).slice(0, MAX_SEARCH_HISTORY)
  } catch (error: unknown) {
    console.warn('Transense could not read the local search history.', error)
    return []
  }
}

export function persistSearchHistory(history: SearchHistoryEntry[]): boolean {
  try {
    window.localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(history))
    return true
  } catch (error: unknown) {
    console.warn('Transense could not save the local search history.', error)
    return false
  }
}
