// Runtime API base URL resolution + WebSocket URL derivation.

const DEFAULT_API_BASE_URL = 'http://localhost:8000'

export const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/$/, '')

export function toWebSocketUrl(baseUrl: string): string {
  const parsedUrl = new URL(baseUrl)
  const protocol = parsedUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${parsedUrl.host}/api/ws`
}
