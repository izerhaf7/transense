import { readFileSync } from 'node:fs'

const connectionSource = readFileSync(new URL('./src/connection.ts', import.meta.url), 'utf8')
const typesSource = readFileSync(new URL('./src/types.ts', import.meta.url), 'utf8')
const source = `${connectionSource}\n${typesSource}`

const requiredContracts = [
  'transcription.session.start',
  'transcription.session.stop',
  'transcription.result',
  'transcription.session.error',
  '/api/transcripts',
  '/api/transcripts/${encodeURIComponent(transcriptId)}/pin',
]

for (const contract of requiredContracts) {
  if (!source.includes(contract)) {
    throw new Error(`Missing transcription frontend contract: ${contract}`)
  }
}

for (const label of ["type TranscriptionSource = 'live' | 'mock' | 'degraded'", "source: 'mock'", "source: 'degraded'"]) {
  if (!source.includes(label)) {
    throw new Error(`Missing explicit transcription state: ${label}`)
  }
}

if (source.includes('MediaRecorder') || source.includes('audio-history') || source.includes('ambient-noise')) {
  throw new Error('Transcription frontend must not retain raw or ambient audio.')
}

console.log('Transcription deterministic checks passed: additive contracts, labels, and text-only handling.')
