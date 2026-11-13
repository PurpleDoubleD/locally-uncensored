// Turning the bytes of a GLB into a three scene, with no network.
//
// The 3D view never fetches an address. The file arrives as bytes over the
// paths every result takes (a local file, a cloud result fetched like any
// other medium), and it is parsed here with GLTFLoader.parse. A GLB may still
// NAME addresses (an external texture or buffer): the LoadingManager below
// turns every address that is not `blob:` or `data:` into an empty data URL
// and counts it, so a model can never make the app reach a foreign server.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { triangleCount, unsupportedCompression, isGlb, type MeshShape } from './mesh-facts'

/** What the loader hands back: the model, its triangles, how many addresses
 *  it named that were dropped. */
export interface LoadedMesh {
  root: THREE.Group
  triangles: number
  blockedUrls: number
}

export class MeshLoadError extends Error {
  constructor(message: string, readonly reason: 'not-glb' | 'compressed' | 'broken') {
    super(message)
    this.name = 'MeshLoadError'
  }
}

export const NOT_A_MODEL = 'This file is not a 3D model LU can show. You can still download it.'
export const COMPRESSED = 'This model is packed in a way the 3D view cannot open yet. You can still download it.'

/** Only addresses that carry their bytes with them may load. */
export function allowedUrl(url: string): boolean {
  return /^(blob|data):/i.test(url.trim())
}

/** An empty stand-in for a refused address. GLTFLoader then fails that one
 *  texture and draws the model without it. */
const REFUSED = 'data:application/octet-stream;base64,'

export function safeManager(onBlocked: () => void): THREE.LoadingManager {
  const manager = new THREE.LoadingManager()
  manager.setURLModifier((url) => {
    if (allowedUrl(url)) return url
    onBlocked()
    return REFUSED
  })
  return manager
}

/** The shape of every mesh below `root`, for the facts line. */
export function meshShapes(root: THREE.Object3D): MeshShape[] {
  const out: MeshShape[] = []
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const g = mesh.geometry
    out.push({ indexCount: g.index ? g.index.count : null, vertexCount: g.attributes.position?.count ?? 0 })
  })
  return out
}

export async function loadGlb(bytes: ArrayBuffer): Promise<LoadedMesh> {
  if (!isGlb(bytes)) throw new MeshLoadError(NOT_A_MODEL, 'not-glb')
  if (unsupportedCompression(bytes)) throw new MeshLoadError(COMPRESSED, 'compressed')
  let blockedUrls = 0
  const loader = new GLTFLoader(safeManager(() => { blockedUrls += 1 }))
  loader.setMeshoptDecoder(MeshoptDecoder)
  try {
    const gltf = await loader.parseAsync(bytes, '')
    const root = gltf.scene as THREE.Group
    return { root, triangles: triangleCount(meshShapes(root)), blockedUrls }
  } catch (err) {
    throw new MeshLoadError(err instanceof Error && /draco|ktx2|basisu/i.test(err.message) ? COMPRESSED : NOT_A_MODEL, 'broken')
  }
}

/** Free the GPU side of a model: geometry, materials and their textures. */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry?.dispose()
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const m of mats) {
      if (!m) continue
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) v.dispose()
      m.dispose()
    }
  })
}
