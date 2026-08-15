import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/tts.ts', import.meta.url), 'utf8')

const requiredContracts = [
  { label: 'TTS endpoint', value: '/api/tts', source },
  { label: 'blob playback via createObjectURL', value: 'URL.createObjectURL', source },
  { label: 'audio element playback', value: 'new Audio(', source },
  { label: 'fallback callback option', value: 'onFallback', source },
]

for (const { label, value, source: target } of requiredContracts) {
  if (!target.includes(value)) {
    throw new Error(`Missing TTS contract: ${label} (${value})`)
  }
}

if (source.includes('as any') || source.includes('@ts-ignore') || source.includes('eslint-disable')) {
  throw new Error('tts.ts must not use type suppression.')
}

// Transpile to CommonJS and run in a VM sandbox with stubbed browser globals
// (fetch / Audio / URL.createObjectURL) so the provider is testable without a browser.
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
  fileName: 'tts.ts',
}).outputText

class FakeAudio {
  constructor(url) {
    this.src = url
    this.onended = null
    this.onerror = null
  }

  play() {
    if (this.onended) this.onended()
    return Promise.resolve()
  }
}

const calls = []
let failFetch = false
const sandbox = {
  module: { exports: {} },
  exports: {},
  console,
  Audio: FakeAudio,
  URL: {
    createObjectURL: (blob) => `blob:mock-${calls.length}`,
    revokeObjectURL: () => {},
  },
  fetch: async (url, init) => {
    if (failFetch) throw new Error('network down')
    calls.push({ url, init })
    return { ok: true, status: 200, blob: async () => new Uint8Array([0x49, 0x44, 0x33]) }
  },
}
vm.createContext(sandbox)
vm.runInContext(transpiled, sandbox, { filename: 'tts.ts' })

const { createTtsProvider } = sandbox.exports

const assert = (condition, message) => {
  if (!condition) throw new Error(`TTS unit test failed: ${message}`)
}

// (a) speak() POSTs {text} to /api/tts, and the base URL has its trailing slash stripped.
const provider = createTtsProvider('http://localhost:8000/')
await provider.speak('Halo dunia')
assert(calls.length === 1, `speak() makes exactly one request, got ${calls.length}`)
assert(calls[0].init.method === 'POST', 'speak() uses POST')
assert(calls[0].url === 'http://localhost:8000/api/tts', `posts to /api/tts (got ${calls[0].url})`)
assert(calls[0].init.headers['Content-Type'] === 'application/json', 'sends JSON content type')
const postedBody = JSON.parse(calls[0].init.body)
assert(postedBody.text === 'Halo dunia', `body contains {text} (got ${JSON.stringify(postedBody)})`)

// (b) identical text is cached: the second speak() of the same text does not refetch.
await provider.speak('Halo dunia')
assert(calls.length === 1, 'identical text reuses the cached audio (fetch called once)')

// Different text triggers a second request.
await provider.speak('Selamat pagi')
assert(calls.length === 2, 'different text triggers a new request')

// (c) on fetch failure the provider calls onFallback(text) and resolves gracefully.
let fallbackText = null
const failing = createTtsProvider('http://localhost:8000', (text) => {
  fallbackText = text
})
failFetch = true
let resolved = false
await failing.speak('   Teks lain   ').then(() => {
  resolved = true
})
assert(resolved === true, 'speak() resolves (never rejects) when synthesis fails')
assert(fallbackText === 'Teks lain', 'onFallback receives the normalized (trimmed) text')

// Empty/whitespace text is a no-op: no request, no fallback.
const callsBefore = calls.length
await provider.speak('   ')
assert(calls.length === callsBefore, 'whitespace-only text makes no request')

console.log('TTS deterministic checks passed: POST contract, audio caching, graceful fallback.')
