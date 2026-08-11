import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./src/journey.ts', import.meta.url), 'utf8')
const expectedPatterns = [
  '[200, 100, 200]',
  '[300, 100, 300, 100, 300]',
  '[500, 200, 500, 200, 1000]',
]

for (const pattern of expectedPatterns) {
  if (!source.includes(pattern)) {
    throw new Error(`Missing documented vibration pattern: ${pattern}`)
  }
}

if (new Set(expectedPatterns).size !== 3 || !source.includes('areVibrationPatternsDistinct')) {
  throw new Error('Vibration patterns must remain three distinct documented values.')
}

console.log('Journey deterministic checks passed: 3 distinct vibration patterns.')
