import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('./src/approach.ts', import.meta.url), 'utf8')

const requiredContracts = [
  { label: 'growth-ratio heuristic', value: 'isApproaching', source },
  { label: 'deterministic announcement', value: 'buildAnnouncement', source },
  { label: 'box tracker', value: 'chooseNextDetection', source },
  { label: 'pure Detection type', value: 'export interface Detection', source },
]

for (const { label, value, source: target } of requiredContracts) {
  if (!target.includes(value)) {
    throw new Error(`Missing approach contract: ${label} (${value})`)
  }
}

if (source.includes('as any') || source.includes('@ts-ignore') || source.includes('eslint-disable')) {
  throw new Error('approach.ts must not use type suppression.')
}

const transpileToCjs = (src, fileName) =>
  ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName,
  }).outputText

// approach.ts is framework-free with no imports, so it runs in a plain VM sandbox.
const mod = { exports: {} }
const sandbox = { module: mod, exports: mod.exports, console }
vm.createContext(sandbox)
vm.runInContext(transpileToCjs(source, 'approach.ts'), sandbox, { filename: 'approach.ts' })

const { isApproaching, buildAnnouncement, chooseNextDetection, boxIoU } = mod.exports

const assert = (condition, message) => {
  if (!condition) throw new Error(`Approach unit test failed: ${message}`)
}

const box = (x, y, width, height, score = 0.95) => ({ box: { x, y, width, height }, score })

// (a) isApproaching: growth must EXCEED the threshold; shrink/same never approach.
assert(isApproaching(null, box(0, 0, 100, 100)) === false, 'a brand-new detection (no previous) is never approaching')
assert(isApproaching(box(0, 0, 100, 100), box(0, 0, 120, 120)) === true, '20% growth triggers approaching')
assert(isApproaching(box(0, 0, 100, 100), box(0, 0, 115, 115)) === false, '15% growth is NOT above the default threshold')
assert(isApproaching(box(0, 0, 120, 120), box(0, 0, 100, 100)) === false, 'a shrinking box never approaches')
assert(isApproaching(box(0, 0, 100, 100), box(0, 0, 100, 100)) === false, 'an unchanged box never approaches')
assert(isApproaching(box(0, 0, 100, 100), box(0, 0, 110, 110), 0.05) === true, 'a custom threshold makes 10% growth approach')

// (b) buildAnnouncement: deterministic Indonesian; OCR corridor only when present.
assert(
  buildAnnouncement(box(0, 0, 100, 100, 0.95), '1') === 'Bus terdeteksi. Koridor 1. Armada mendekat.',
  'announcement includes the OCR corridor when present',
)
assert(
  buildAnnouncement(box(0, 0, 100, 100, 0.95), null) === 'Bus terdeteksi. Armada mendekat.',
  'announcement without OCR text',
)
assert(
  buildAnnouncement(box(0, 0, 100, 100, 0.95), '   ') === 'Bus terdeteksi. Armada mendekat.',
  'a whitespace OCR result is an empty reading, not a fabricated corridor',
)
assert(
  buildAnnouncement(box(0, 0, 100, 100, 0.6), null) === 'Bus terdeteksi. Armada mendekat. Keyakinan rendah.',
  'low-confidence detections stay honest with a spoken qualifier',
)

// (c) chooseNextDetection: same-box continuity wins, else the higher score.
const tracked = box(10, 10, 100, 100)
assert(chooseNextDetection(null, tracked) === tracked, 'the first detection seeds the tracker')
const grown = box(10, 10, 130, 130)
assert(chooseNextDetection(tracked, grown) === grown, 'an overlapping (same bus) box keeps the newest frame')
const elsewhere = box(300, 300, 40, 40, 0.99)
assert(chooseNextDetection(tracked, elsewhere) === elsewhere, 'a non-overlapping higher-score box takes over')
const flicker = box(300, 300, 40, 40, 0.3)
assert(chooseNextDetection(tracked, flicker) === tracked, 'a non-overlapping lower-score box keeps the tracked bus')

// (d) IoU sanity: identical boxes IoU 1, disjoint boxes IoU 0.
assert(boxIoU(box(0, 0, 10, 10).box, box(0, 0, 10, 10).box) === 1, 'identical boxes have IoU 1')
assert(boxIoU(box(0, 0, 10, 10).box, box(100, 100, 10, 10).box) === 0, 'disjoint boxes have IoU 0')

console.log('Approach deterministic checks passed: growth heuristic, announcement format, tracked-box continuity.')
