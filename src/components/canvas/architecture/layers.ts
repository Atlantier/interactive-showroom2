import * as THREE from 'three'

/**
 * Per-layer metadata for the click-to-focus interaction.
 *
 * Shared by the 3D scene (to know where to aim the camera) and the DOM HUD (to
 * know what to display), which is why it lives in its own module rather than
 * being duplicated in both.
 */

export interface LayerTech {
  /** Technology name. A proper noun, so it is not localised. */
  name: string
}

/**
 * Closed union: every id is also a key into `t.architecture.layers`, so the HUD
 * cannot ask for copy that does not exist.
 */
export type LayerId = 'infra' | 'agents' | 'spatial'

export interface LayerInfo {
  id: LayerId
  index: string
  /** Display title, e.g. "Infrastructure". */
  title: string
  /** Sub-title shown under the title, e.g. "CUDA Kernel Layer". */
  subtitle: string
  /**
   * Technology stack rows for the HUD. Names only; the per-row descriptions are
   * resolved from the dictionary by index so they follow the locale.
   */
  tech: LayerTech[]
  /** Accent colour for the HUD and the focus ring. */
  accent: string
  /**
   * Local-space Y of the layer's centre while the stack is fully assembled.
   * Must match `LAYER_Y.rest` in `cameraPath.ts`.
   */
  restY: number
}

export const LAYERS: LayerInfo[] = [
  {
    id: 'infra',
    index: '01',
    title: 'Infrastructure',
    subtitle: 'CUDA Kernel Layer',
    accent: '#22d3ee',
    restY: -0.95,
    tech: [
      { name: 'CUDA Kernels' },
      { name: 'TensorRT-LLM' },
      { name: 'NCCL Fabric' },
      { name: 'NVLink' },
      { name: 'Memory' },
    ],
  },
  {
    id: 'agents',
    index: '02',
    title: 'Orchestration',
    subtitle: 'Multi-Agent Layer',
    accent: '#a78bfa',
    restY: 0,
    tech: [
      { name: 'Agent Runtime' },
      { name: 'Router' },
      { name: 'Vector Store' },
      { name: 'State Machine' },
      { name: 'Observability' },
    ],
  },
  {
    id: 'spatial',
    index: '03',
    title: 'Spatial Web',
    subtitle: 'UI & Interaction Layer',
    accent: '#5eead4',
    restY: 0.95,
    tech: [
      { name: 'WebGL 2' },
      { name: 'React 19' },
      { name: 'Motion' },
      { name: 'Lenis' },
      { name: 'Accessibility' },
    ],
  },
]

/** Look up a layer by id. */
export function findLayer(id: string | null): LayerInfo | null {
  if (!id) return null
  return LAYERS.find((l) => l.id === id) ?? null
}

/**
 * Camera pose for a close-up of one layer.
 *
 * Deliberately NOT derived from the scroll path: clicking a layer must produce a
 * deliberate, repeatable framing regardless of where the user was in the
 * narrative. The distance is chosen so the layer's width (~6 units for the
 * infrastructure plate) fills a 42° FOV frame with margin.
 */
export interface FocusPose {
  position: THREE.Vector3Tuple
  target: THREE.Vector3Tuple
}

export function focusPoseFor(layer: LayerInfo): FocusPose {
  // Aim at the layer's resting centre; the rig adds the live separation offset.
  const y = layer.restY
  if (layer.id === 'infra') {
    // Look down at the silicon plate from a raised 3/4 angle.
    return { position: [3.1, y + 2.4, 5.4], target: [0, y, 0] }
  }
  if (layer.id === 'agents') {
    // Level with the node cloud, close in, so the octahedra read as objects.
    return { position: [0.9, y + 0.9, 4.3], target: [0, y, 0] }
  }
  // Prism: slightly above, so the refraction picks up the environment edges.
  return { position: [-2.4, y + 1.5, 4.6], target: [0, y, 0] }
}
