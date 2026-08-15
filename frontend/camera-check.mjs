import { readFileSync } from 'node:fs'

const workerSource = readFileSync(new URL('./src/mediapipe.worker.ts', import.meta.url), 'utf8')
const componentSource = readFileSync(new URL('./src/CameraScan.tsx', import.meta.url), 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

// (a) The detector must be restricted to the "bus" COCO category.
assert(
  workerSource.includes("categoryAllowlist: ['bus']") || workerSource.includes("['bus']"),
  'Missing bus categoryAllowlist in mediapipe.worker.ts',
)

// (b) The worker must run the synchronous video detector.
assert(workerSource.includes('detectForVideo'), 'Missing detectForVideo in mediapipe.worker.ts')

// (c) The component must request the rear camera stream.
assert(componentSource.includes('getUserMedia'), 'Missing getUserMedia in CameraScan.tsx')

// (d) The simulated-detection affordance must stay available for deterministic demos.
assert(componentSource.includes('Simulasikan armada'), 'Missing "Simulasikan armada" simulated-detection affordance in CameraScan.tsx')

// (e) Strict TS: no type suppression in either new file.
for (const [name, source] of [
  ['mediapipe.worker.ts', workerSource],
  ['CameraScan.tsx', componentSource],
]) {
  if (source.includes('as any') || source.includes('@ts-ignore') || source.includes('eslint-disable')) {
    throw new Error(`${name} must not use type suppression.`)
  }
}

// (f) @mediapipe/tasks-vision must stay pinned to ^1.0.1.
assert(
  packageJson.dependencies?.['@mediapipe/tasks-vision'] === '^1.0.1',
  '@mediapipe/tasks-vision must be pinned to ^1.0.1 in package.json',
)

// Extra guard: the worker must accept simulated detections through the same
// protocol as real frames, so the demo path can never drift from the camera path.
assert(workerSource.includes('simulatedDetections'), 'Worker must support simulatedDetections in its protocol')

// Extra guard: the component must spawn the module worker via Vite's URL pattern.
assert(
  componentSource.includes("new Worker(new URL('./mediapipe.worker.ts', import.meta.url)"),
  'CameraScan.tsx must spawn the mediapipe worker via Vite module-worker URL',
)

console.log('Camera deterministic checks passed: bus allowlist, worker detection, camera stream, simulated affordance, no type suppression, pinned tasks-vision.')
