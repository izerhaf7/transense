/**
 * Per-stop 360° panorama configuration for the Side by Side daksa renderer.
 *
 * Only stops with a bundled cylindrical panorama image (`frontend/public/panorama/`)
 * get a config; every other stop falls back to the static "Pratinjau 360°"
 * placeholder in SideBySidePage. Chip yaw values are demo-realistic annotations
 * (0..360 degrees) positioning each accessibility facility on the panorama.
 */

export interface PanoramaChip {
  /** Facility key matching FacilityStop['facilities'] (e.g. 'ramp'). */
  facility: string
  /** Compass-style viewing direction of the facility, 0..360 degrees. */
  yaw: number
}

export interface PanoramaConfig {
  stopId: string
  imageUrl: string
  chips: PanoramaChip[]
}

const PANORAMA_CONFIGS: Readonly<Record<string, PanoramaConfig>> = {
  'fac-bundaran-hi': {
    stopId: 'fac-bundaran-hi',
    imageUrl: '/panorama/bundaran-hi.jpg',
    chips: [
      { facility: 'ramp', yaw: 90 },
      { facility: 'lift', yaw: 180 },
      { facility: 'guiding_block', yaw: 270 },
      { facility: 'staffed', yaw: 45 },
    ],
  },
  'fac-senayan': {
    stopId: 'fac-senayan',
    imageUrl: '/panorama/senayan.jpg',
    chips: [
      { facility: 'ramp', yaw: 120 },
      { facility: 'lift', yaw: 200 },
      { facility: 'guiding_block', yaw: 300 },
    ],
  },
}

/** Returns the panorama config for a stop, or null when none exists. */
export function getPanoramaConfig(stopId: string): PanoramaConfig | null {
  return PANORAMA_CONFIGS[stopId] ?? null
}
