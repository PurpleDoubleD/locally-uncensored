// The formats of the Download menu besides the GLB (C3D-PLAN 1.4). The GLB is
// the delivered file, unchanged. OBJ, STL and USDZ are computed from the
// loaded scene with three's own exporters.
import type * as THREE from 'three'
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js'
import { STLExporter } from 'three/addons/exporters/STLExporter.js'

export type MeshFormat = 'glb' | 'obj' | 'stl' | 'usdz'

export interface MeshFormatInfo {
  id: MeshFormat
  label: string
  note: string
  mime: string
}

export const MESH_FORMATS: readonly MeshFormatInfo[] = [
  { id: 'glb', label: 'GLB', note: 'the original, with colors', mime: 'model/gltf-binary' },
  { id: 'obj', label: 'OBJ', note: 'shape only', mime: 'model/obj' },
  { id: 'stl', label: 'STL', note: 'for 3D printing, shape only', mime: 'model/stl' },
  { id: 'usdz', label: 'USDZ', note: 'for iPhone and Mac', mime: 'model/vnd.usdz+zip' },
]

export function exportObj(root: THREE.Object3D): Uint8Array {
  return new TextEncoder().encode(new OBJExporter().parse(root))
}

export function exportStl(root: THREE.Object3D): Uint8Array {
  const view = new STLExporter().parse(root, { binary: true }) as unknown as DataView
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

/** USDZ takes only standard materials (three's own note). Loaded lazily: the
 *  exporter pulls a zip writer the other formats do not need. */
export async function exportUsdz(root: THREE.Object3D): Promise<Uint8Array> {
  const { USDZExporter } = await import('three/addons/exporters/USDZExporter.js')
  const buffer = await new USDZExporter().parseAsync(root as THREE.Object3D)
  return new Uint8Array(buffer)
}

/** The bytes of one format. `original` is the GLB as it was delivered. */
export async function exportMesh(format: MeshFormat, root: THREE.Object3D, original: Uint8Array): Promise<Uint8Array> {
  switch (format) {
    case 'glb': return original
    case 'obj': return exportObj(root)
    case 'stl': return exportStl(root)
    case 'usdz': return exportUsdz(root)
  }
}
